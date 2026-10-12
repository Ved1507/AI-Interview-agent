/**
 * Scoring Engine
 * Orchestrates the complete scoring process for interviews
 */

import { InterviewSessionModel } from '../database/models/InterviewSession';
import { ScoringResultModel } from '../database/models/ScoringResult';
import { RecommendationModel } from '../database/models/Recommendation';
import { OpenAIService } from '../services/OpenAIService';
import {
  ScoringData,
  DimensionScore,
  RecommendationData,
} from '../types/interview.types';
import { Logger } from '../utils/logger';
import { verifyQuotes } from '../utils/quotes';
import { cvForModel } from '../security/promptData';

const logger = new Logger('ScoringEngine');

const DIMENSION_WEIGHTS = {
  technical_skills: 0.4,
  domain_understanding: 0.2,
  problem_solving: 0.2,
  communication: 0.1,
};

export class ScoringEngine {
  /**
   * Run complete scoring for an interview
   */
  static async scoreInterview(
    sessionId: string,
    jobDescription: string,
    cvText?: string
  ): Promise<{
    scoring: ScoringData;
    recommendation: RecommendationData;
    metrics: {
      totalCost: number;
      totalLatency: number;
      totalTokens: number;
    };
  }> {
    const startTime = Date.now();
    let totalCost = 0;
    let totalTokens = 0;

    try {
      // Get interview session
      const session = await InterviewSessionModel.getById(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      // Get full transcript
      const transcript = this.buildTranscript(session);
      const questionGuide = this.buildQuestionGuide(session);

      // Score each dimension
      const scores: Record<string, DimensionScore> = {};
      const dimensions = [
        'technical_skills',
        'domain_understanding',
        'problem_solving',
        'communication',
      ];

      const scoreOne = (dimension: string) =>
        OpenAIService.scoreResponseDimension(
          sessionId,
          transcript,
          dimension,
          this.getRubricForDimension(dimension),
          jobDescription,
          cvForModel(cvText || '').text || undefined,
          questionGuide || undefined
        ).then((result) => {
          scores[dimension] = {
            score: result.score * 20, // Convert 1-5 to 0-100
            confidence: result.confidence,
            evidence_quotes: result.evidenceQuotes,
            reasoning: result.reasoning,
          };

          totalCost += result.metrics.cost;
          totalTokens += result.metrics.inputTokens + result.metrics.outputTokens;

          logger.debug('Dimension scored', {
            dimension,
            score: result.score,
            cost: result.metrics.cost,
          });
        });

      // The first call runs alone, so it writes the shared prompt prefix to the provider's cache.
      // The other three then run in parallel and reuse that prefix.
      await scoreOne(dimensions[0]);
      await Promise.all(dimensions.slice(1).map(scoreOne));

      // Keep only quotes that really appear in the transcript. A dimension with no verified
      // quote cannot be confident, so its confidence is capped.
      let quotesDropped = 0;
      for (const dimension of dimensions) {
        const score = scores[dimension];
        if (!score) continue;
        const check = verifyQuotes(score.evidence_quotes || [], transcript);
        quotesDropped += check.dropped;
        score.evidence_quotes = check.kept;
        if (check.kept.length === 0) {
          score.confidence = Math.min(score.confidence, 0.5);
        }
      }
      if (quotesDropped > 0) {
        logger.warn('Unverified evidence quotes removed', { sessionId, quotesDropped });
      }

      // Calculate weighted score
      const weightedScore = this.calculateWeightedScore(scores);

      // Create scoring data
      const scoring: ScoringData = {
        status: 'completed',
        dimensions: {
          technical_skills: scores.technical_skills,
          domain_understanding: scores.domain_understanding,
          problem_solving: scores.problem_solving,
          communication: scores.communication,
        },
        weighted_score: weightedScore,
        scoring_timestamp: new Date().toISOString(),
      };

      // Store scoring results
      await ScoringResultModel.upsert(sessionId, scoring);

      // Generate recommendation
      const recommendation = this.generateRecommendation(
        weightedScore,
        scores
      );

      // Store recommendation
      await RecommendationModel.create(sessionId, recommendation);

      const totalLatency = Date.now() - startTime;

      logger.info('Interview scored', {
        sessionId,
        score: weightedScore,
        totalCost: totalCost.toFixed(4),
        totalLatency,
      });

      return {
        scoring,
        recommendation,
        metrics: {
          totalCost,
          totalLatency,
          totalTokens,
        },
      };
    } catch (error) {
      logger.error('Failed to score interview', { error, sessionId });
      throw error;
    }
  }

  /**
   * Candidate-only transcript: each question, its answer, and any follow-up exchange.
   * Evidence quotes are checked against this text, so it must hold only what the candidate said
   * and the question wording, never scoring guides.
   */
  private static buildTranscript(session: any): string {
    const responses: any[] = session.responses || [];
    if (responses.length === 0) {
      return '';
    }

    const questions: any[] = session.questions || [];
    if (questions.length === 0) {
      // Older sessions have no stored question text
      return responses
        .map((r, i) => [`Q${i + 1}: ${r.transcript}`, ...(r.follow_ups || []).map((f: any) => `Follow-up: ${f.transcript}`)].join('\n\n'))
        .join('\n\n');
    }

    const blocks: string[] = [];
    questions
      .filter((q) => q.generated_by_mode !== 'follow_up')
      .forEach((q, index) => {
        const response = responses.find((r) => r.question_instance_id === q.id);
        blocks.push(`Q${index + 1}: ${q.text}\nA: ${response ? response.transcript : '(not answered)'}`);
        for (const followUp of response?.follow_ups || []) {
          blocks.push(`Follow-up (${followUp.trigger || 'probe'}): ${followUp.text}\nA: ${followUp.transcript}`);
        }
      });

    return blocks.join('\n\n');
  }

  /**
   * Scoring guides for each main question, from the question bank. Sent to the model separately from the transcript.
   */
  private static buildQuestionGuide(session: any): string {
    const questions: any[] = (session.questions || []).filter((q: any) => q.generated_by_mode !== 'follow_up');
    return questions
      .map((q, index) => {
        const rubric = q.rubric || {};
        if (!rubric['1'] && !rubric['5']) return '';
        const skills = (q.skill_area || []).join(', ');
        return `Q${index + 1} (${skills || 'general'}): 1 = ${rubric['1'] || 'weak'}; 3 = ${rubric['3'] || 'adequate'}; 5 = ${rubric['5'] || 'strong'}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Get rubric for a dimension
   */
  private static getRubricForDimension(dimension: string): Record<string, string> {
    const rubrics: Record<string, Record<string, string>> = {
      technical_skills: {
        '1': 'No relevant technical knowledge or significant gaps',
        '2': 'Basic technical knowledge with notable limitations',
        '3': 'Solid technical understanding with minor gaps',
        '4': 'Strong technical expertise with clear depth',
        '5': 'Exceptional technical mastery and advanced knowledge',
      },
      domain_understanding: {
        '1': 'No understanding of domain or best practices',
        '2': 'Limited understanding with surface-level knowledge',
        '3': 'Good understanding of key domain concepts',
        '4': 'Strong domain knowledge and awareness of best practices',
        '5': 'Expert domain knowledge with sophisticated insights',
      },
      problem_solving: {
        '1': 'Lacks analytical approach or cannot solve problems',
        '2': 'Limited problem-solving ability with unclear reasoning',
        '3': 'Reasonable problem-solving with logical approach',
        '4': 'Strong problem-solving with clear trade-off analysis',
        '5': 'Exceptional problem-solving with sophisticated approach',
      },
      communication: {
        '1': 'Poor communication, unclear or incoherent',
        '2': 'Difficult to follow, lacks clarity and structure',
        '3': 'Clear communication with reasonable structure',
        '4': 'Excellent communication, well-organized and articulate',
        '5': 'Outstanding communication, engaging and precise',
      },
    };

    return rubrics[dimension] || rubrics.technical_skills;
  }

  /**
   * Calculate weighted score from dimension scores
   */
  private static calculateWeightedScore(
    scores: Record<string, DimensionScore>
  ): number {
    let totalScore = 0;
    let totalWeight = 0;

    for (const [dimension, weight] of Object.entries(DIMENSION_WEIGHTS)) {
      const score = scores[dimension];
      if (score) {
        totalScore += score.score * weight;
        totalWeight += weight;
      }
    }

    return totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;
  }

  /**
   * Generate recommendation from scores
   */
  private static generateRecommendation(
    weightedScore: number,
    scores: Record<string, DimensionScore>
  ): RecommendationData {
    // Map score to recommendation level
    let level: 'strong_hire' | 'hire' | 'hold' | 'no_hire';
    if (weightedScore >= 80) {
      level = 'strong_hire';
    } else if (weightedScore >= 70) {
      level = 'hire';
    } else if (weightedScore >= 60) {
      level = 'hold';
    } else {
      level = 'no_hire';
    }

    // Calculate confidence based on variance
    const scoreValues = Object.values(scores).map((s) => s.score);
    const confidence = this.calculateConfidence(scoreValues);

    // Identify strengths and gaps
    const strengths = Object.entries(scores)
      .filter(([_, score]) => score.score >= 75)
      .map(([dimension, _]) => `Strong ${dimension.replace(/_/g, ' ')}`);

    const gaps = Object.entries(scores)
      .filter(([_, score]) => score.score < 65)
      .map(([dimension, _]) => `Needs improvement in ${dimension.replace(/_/g, ' ')}`);

    const reasoning = `Candidate scored ${weightedScore}/100 overall. ${
      strengths.length > 0
        ? `Strengths: ${strengths.join(', ')}.`
        : ''
    } ${gaps.length > 0 ? `Areas for growth: ${gaps.join(', ')}.` : ''}`;

    return {
      level,
      confidence,
      reasoning,
      strengths,
      growth_areas: gaps,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Calculate confidence level based on score variance
   */
  private static calculateConfidence(
    scores: number[]
  ): 'high' | 'medium' | 'low' {
    if (scores.length === 0) {
      return 'low';
    }

    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance =
      scores.reduce((sum, score) => sum + Math.pow(score - mean, 2), 0) /
      scores.length;
    const stdDev = Math.sqrt(variance);

    // High confidence: low variance
    if (stdDev < 10) {
      return 'high';
    } else if (stdDev < 20) {
      return 'medium';
    } else {
      return 'low';
    }
  }
}
