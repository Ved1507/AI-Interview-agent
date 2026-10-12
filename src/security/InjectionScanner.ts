/**
 * Prompt-injection scanner, three layers (see README, section 5):
 *   1. Pattern matching: fast regex rules, low false-positive rate.
 *   2. Semantic analysis: the model classifies the text. If the model is unavailable, layer 1 still runs.
 *   3. Post-scoring review: flags are stored and shown to the reviewer. They never change a score automatically.
 *
 * Both the candidate's answers and the CV are scanned. Flags carry a location so the reviewer knows where to look.
 */

import { OpenAIService } from '../services/OpenAIService';
import { InterviewSessionModel } from '../database/models/InterviewSession';
import { JsonStorage } from '../storage/JsonStorage';
import { mainQuestions } from '../interview/InterviewFlow';
import { InjectionFlag, ResponseData, InterviewSession } from '../types/interview.types';
import { Logger } from '../utils/logger';

const logger = new Logger('InjectionScanner');

/** Semantic flags below this confidence are dropped to limit noise */
const SEMANTIC_CONFIDENCE_THRESHOLD = 0.7;
const SNIPPET_CHARS = 300;
/** The CV is checked in pieces, so an injection near the end of a long CV is still seen */
const CV_CHUNK_CHARS = 4000;
const CV_CHUNK_OVERLAP = 400;
/** Flags for the CV carry this response ID, so they can be kept apart from answer flags */
export const CV_FLAG_ID = 'candidate_cv';

interface PatternRule {
  id: string;
  severity: 'low' | 'medium' | 'high';
  regex: RegExp;
}

const PATTERN_RULES: PatternRule[] = [
  {
    id: 'ignore_instructions',
    severity: 'high',
    regex: /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|system)\s+(instructions?|prompts?|rules?|directions?|messages?)/i,
  },
  {
    id: 'score_manipulation',
    severity: 'high',
    regex: /\b(rate|score|grade|mark)\s+(me|this candidate|the candidate|myself)\b[^.\n]{0,40}\b(5|five|10|ten|perfect|maximum|full marks)\b/i,
  },
  {
    id: 'direct_recommendation',
    severity: 'high',
    regex: /\b(recommend|hire|approve|pass)\s+(me|this candidate|the candidate)\b/i,
  },
  {
    id: 'role_change',
    severity: 'high',
    regex: /\byou are (now|no longer)\b|\bpretend (to be|you are)\b/i,
  },
  {
    id: 'system_prompt_reference',
    severity: 'medium',
    regex: /\b(system|hidden|developer)\s+(prompt|message|instructions?)\b/i,
  },
  {
    id: 'new_instructions',
    severity: 'medium',
    regex: /\b(new|updated|real|actual)\s+instructions?\s*:/i,
  },
  {
    id: 'delimiter_injection',
    severity: 'medium',
    regex: /<\/?\s*(system|assistant|instructions?|prompt|candidate_cv|candidate_text)\s*>|\[\/?(INST|SYS)\]|#{3}\s*(system|instruction)/i,
  },
  {
    id: 'role_change_soft',
    severity: 'low',
    regex: /\bact as (a |an )?/i,
  },
  {
    id: 'jailbreak_terms',
    severity: 'low',
    regex: /\b(jailbreak|developer mode|DAN mode)\b/i,
  },
];

/** Text around a match, so the reviewer can see the context */
function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + length + 80);
  return text.slice(start, end).slice(0, SNIPPET_CHARS);
}

/** Layer 1 over any piece of text */
function matchPatterns(text: string): { pattern: string; severity: 'low' | 'medium' | 'high'; snippet: string }[] {
  const matches: { pattern: string; severity: 'low' | 'medium' | 'high'; snippet: string }[] = [];
  for (const rule of PATTERN_RULES) {
    const match = rule.regex.exec(text);
    if (match) {
      matches.push({
        pattern: rule.id,
        severity: rule.severity,
        snippet: snippetAround(text, match.index, match[0].length),
      });
    }
  }
  return matches;
}

/** Split long text into overlapping pieces for the semantic check */
function chunks(text: string): string[] {
  if (text.length <= CV_CHUNK_CHARS) return [text];
  const pieces: string[] = [];
  for (let start = 0; start < text.length; start += CV_CHUNK_CHARS - CV_CHUNK_OVERLAP) {
    pieces.push(text.slice(start, start + CV_CHUNK_CHARS));
    if (start + CV_CHUNK_CHARS >= text.length) break;
  }
  return pieces;
}

export class InjectionScanner {

  /**
   * Scan the CV when it is stored. Its flags are kept apart from the answer flags.
   * A flagged CV is never rejected; the reviewer decides.
   */
  static async scanCv(sessionId: string, text: string): Promise<{ flags: InjectionFlag[]; semanticAvailable: boolean }> {
    const flags: InjectionFlag[] = [];
    const timestamp = new Date().toISOString();

    for (const m of matchPatterns(text)) {
      flags.push({
        response_id: CV_FLAG_ID,
        pattern_matched: m.pattern,
        severity: m.severity,
        flagged_text: m.snippet,
        timestamp,
        layer: 'pattern',
        location: 'CV',
      });
    }

    let semanticAvailable = true;
    const pieces = chunks(text);
    for (let i = 0; i < pieces.length && semanticAvailable; i++) {
      try {
        const result = await OpenAIService.detectInjection(sessionId, pieces[i]);
        if (result.detected && result.confidence >= SEMANTIC_CONFIDENCE_THRESHOLD) {
          flags.push({
            response_id: CV_FLAG_ID,
            pattern_matched: result.pattern || 'semantic_injection',
            severity: result.severity,
            flagged_text: pieces[i].slice(0, SNIPPET_CHARS),
            timestamp,
            layer: 'semantic',
            confidence: result.confidence,
            location: pieces.length > 1 ? `CV (part ${i + 1} of ${pieces.length})` : 'CV',
          });
        }
      } catch (error) {
        semanticAvailable = false;
        logger.warn('Semantic CV check unavailable', { sessionId });
      }
    }

    this.storeFlags(sessionId, 'cv', flags);
    InterviewSessionModel.appendAudit(sessionId, {
      action: 'cv_injection_scan_completed',
      timestamp,
      user_id: 'system',
      details: { flags: flags.length, semantic_check: semanticAvailable ? 'ok' : 'unavailable' },
    });

    return { flags, semanticAvailable };
  }

  /**
   * Scan every answer in a completed session and store the result.
   * Scores are not changed here; the flags go to the human reviewer.
   */
  static async scanSession(sessionId: string): Promise<{ flags: InjectionFlag[]; semanticAvailable: boolean }> {
    const session = await InterviewSessionModel.getById(sessionId);
    if (!session) throw new Error('Session not found');

    const flags: InjectionFlag[] = [];
    let semanticAvailable = true;

    // Main answers and follow-up answers are scanned the same way
    const segments: { id: string; text: string; location: string }[] = [];
    for (const response of session.responses) {
      const questionNumber = this.questionNumber(session, response);
      segments.push({ id: response.id, text: response.transcript || '', location: `Question ${questionNumber}` });
      for (const followUp of response.follow_ups || []) {
        segments.push({ id: followUp.id, text: followUp.transcript || '', location: `Question ${questionNumber} follow-up` });
      }
    }

    for (const segment of segments) {
      const timestamp = new Date().toISOString();
      for (const m of matchPatterns(segment.text)) {
        flags.push({
          response_id: segment.id,
          pattern_matched: m.pattern,
          severity: m.severity,
          flagged_text: m.snippet,
          timestamp,
          layer: 'pattern',
          location: segment.location,
        });
      }

      if (segment.text.trim().split(/\s+/).length < 3) continue;

      if (semanticAvailable) {
        try {
          const result = await OpenAIService.detectInjection(sessionId, segment.text);
          if (result.detected && result.confidence >= SEMANTIC_CONFIDENCE_THRESHOLD) {
            flags.push({
              response_id: segment.id,
              pattern_matched: result.pattern || 'semantic_injection',
              severity: result.severity,
              flagged_text: segment.text.slice(0, SNIPPET_CHARS),
              timestamp,
              layer: 'semantic',
              confidence: result.confidence,
              location: segment.location,
            });
          }
        } catch (error) {
          // The model is unavailable; layer 1 still ran, so the scan continues
          semanticAvailable = false;
          logger.warn('Semantic injection check unavailable', { sessionId });
        }
      }
    }

    this.storeFlags(sessionId, 'answers', flags);

    const high = flags.filter((f) => f.severity === 'high').length;
    InterviewSessionModel.appendAudit(sessionId, {
      action: 'injection_scan_completed',
      timestamp: new Date().toISOString(),
      user_id: 'system',
      details: { flags: flags.length, high, semantic_check: semanticAvailable ? 'ok' : 'unavailable' },
    });

    return { flags, semanticAvailable };
  }

  /**
   * Replace one kind of flag and keep the other. A CV scan replaces only CV flags;
   * an answer scan replaces only answer flags.
   */
  private static storeFlags(sessionId: string, scope: 'cv' | 'answers', flags: InjectionFlag[]): void {
    const session = JsonStorage.load<InterviewSession>('interviews', sessionId);
    const existing = session?.security_flags?.injection_attempts_detected || [];
    const isCv = (f: InjectionFlag) => f.response_id === CV_FLAG_ID;
    const kept = scope === 'cv' ? existing.filter((f) => !isCv(f)) : existing.filter(isCv);
    InterviewSessionModel.setInjectionFlags(sessionId, [...kept, ...flags]);
  }

  private static questionNumber(session: InterviewSession, response: ResponseData): number {
    const index = mainQuestions(session).findIndex((q) => q.id === response.question_instance_id);
    return index + 1;
  }
}
