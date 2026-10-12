/**
 * InterviewSession Model
 * Represents a complete interview session with all related data
 */

import { JsonStorage } from '../../storage/JsonStorage';
import {
  AuditEntry,
  CvClaim,
  FollowUpResponse,
  HumanReviewData,
  InjectionFlag,
  InterviewSession,
  QuestionInstance,
  RecommendationData,
  ResponseData,
  ScoringData,
} from '../../types/interview.types';
import { Logger } from '../../utils/logger';
import { retentionDeadline } from '../../retention/retentionPolicy';
import { v4 as uuidv4 } from 'uuid';

const logger = new Logger('InterviewSession');

export class InterviewSessionModel {
  /**
   * Create a new interview session
   */
  static async create(data: {
    candidate_id: string;
    job_id: string;
    mode: 'A' | 'B' | 'C';
    interviewer_id?: string;
  }): Promise<InterviewSession> {
    try {
      const session: InterviewSession = {
        id: uuidv4(),
        candidate_id: data.candidate_id,
        job_id: data.job_id,
        mode: data.mode,
        interviewer_id: data.interviewer_id || null,
        status: 'initialized',
        consent: {
          data_storage: false,
          timestamp: null,
        },
        questions: [],
        responses: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        retention_until: retentionDeadline(),
      };

      JsonStorage.save('interviews', session);

      logger.info('Interview session created', {
        id: session.id,
        candidate_id: data.candidate_id,
        job_id: data.job_id,
        mode: data.mode,
      });

      return session;
    } catch (error) {
      logger.error('Failed to create interview session', { error });
      throw error;
    }
  }

  /**
   * Get interview session by ID
   */
  static async getById(sessionId: string): Promise<InterviewSession | null> {
    try {
      return JsonStorage.load<InterviewSession>('interviews', sessionId);
    } catch (error) {
      logger.error('Failed to get interview session', { error, sessionId });
      return null;
    }
  }

  /**
   * Update interview session status
   */
  static async updateStatus(
    sessionId: string,
    status: InterviewSession['status']
  ): Promise<void> {
    try {
      JsonStorage.update<InterviewSession>('interviews', sessionId, {
        status,
        updated_at: new Date().toISOString(),
      });

      logger.info('Interview session status updated', {
        id: sessionId,
        status,
      });
    } catch (error) {
      logger.error('Failed to update session status', { error, sessionId });
      throw error;
    }
  }

  /**
   * Add consent information to session
   */
  static async addConsent(
    sessionId: string,
    consent: {
      data_storage: boolean;
      third_party_ai?: boolean;
      ai_agent_notice?: boolean;
    }
  ): Promise<void> {
    try {
      JsonStorage.update<InterviewSession>('interviews', sessionId, {
        consent: {
          data_storage: consent.data_storage,
          third_party_ai: consent.third_party_ai === true,
          ai_agent_notice: consent.ai_agent_notice === true,
          timestamp: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      });

      logger.info('Consent added to session', { id: sessionId });
    } catch (error) {
      logger.error('Failed to add consent', { error, sessionId });
      throw error;
    }
  }

  /**
   * Start interview (set started_at timestamp)
   */
  static async start(sessionId: string): Promise<void> {
    try {
      JsonStorage.update<InterviewSession>('interviews', sessionId, {
        status: 'in_progress',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      logger.info('Interview started', { id: sessionId });
    } catch (error) {
      logger.error('Failed to start interview', { error, sessionId });
      throw error;
    }
  }

  /**
   * Complete interview (set completed_at and calculate duration)
   */
  static async complete(sessionId: string): Promise<void> {
    try {
      const session = await this.getById(sessionId);
      if (!session) throw new Error('Session not found');

      const startTime = new Date(session.started_at || new Date()).getTime();
      const endTime = Date.now();
      const duration = Math.round((endTime - startTime) / 60000);

      JsonStorage.update<InterviewSession>('interviews', sessionId, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_duration_minutes: duration,
        updated_at: new Date().toISOString(),
      });

      logger.info('Interview completed', { id: sessionId });
    } catch (error) {
      logger.error('Failed to complete interview', { error, sessionId });
      throw error;
    }
  }

  /**
   * Replace the question list for a session
   */
  static setQuestions(sessionId: string, questions: QuestionInstance[]): void {
    JsonStorage.update<InterviewSession>('interviews', sessionId, {
      questions,
      updated_at: new Date().toISOString(),
    });
  }

  /**
   * Append a candidate response to a session
   */
  static addResponse(sessionId: string, response: ResponseData): void {
    const session = JsonStorage.load<InterviewSession>('interviews', sessionId);
    if (!session) throw new Error('Session not found');

    JsonStorage.update<InterviewSession>('interviews', sessionId, {
      responses: [...session.responses, response],
      updated_at: new Date().toISOString(),
    });
  }

  /**
   * Store a follow-up answer under the response to its parent question
   */
  static addFollowUpResponse(sessionId: string, parentQuestionId: string, followUp: FollowUpResponse): void {
    const session = JsonStorage.load<InterviewSession>('interviews', sessionId);
    if (!session) throw new Error('Session not found');

    const responses = session.responses.map((r) =>
      r.question_instance_id === parentQuestionId
        ? { ...r, follow_ups: [...(r.follow_ups || []), followUp] }
        : r
    );
    if (!responses.some((r) => r.question_instance_id === parentQuestionId)) {
      throw new Error('The parent question has not been answered');
    }

    JsonStorage.update<InterviewSession>('interviews', sessionId, {
      responses,
      updated_at: new Date().toISOString(),
    });
  }

  /**
   * Store the candidate CV text used for scoring and the report
   */
  static setCandidateLink(
    sessionId: string,
    link: { token_hash: string; created_at: string; expires_at: string }
  ): void {
    JsonStorage.update<InterviewSession>('interviews', sessionId, {
      candidate_link: link,
      updated_at: new Date().toISOString(),
    });
  }

  /** The session whose candidate link has this token hash, or null */
  static async findByLinkTokenHash(tokenHash: string): Promise<InterviewSession | null> {
    const matches = JsonStorage.query<InterviewSession>(
      'interviews',
      (s) => s.candidate_link?.token_hash === tokenHash
    );
    return matches[0] || null;
  }

  static setCvClaims(sessionId: string, claims: CvClaim[]): void {
    JsonStorage.update<InterviewSession>('interviews', sessionId, {
      cv_claims: claims,
      updated_at: new Date().toISOString(),
    });
  }

  static setCv(sessionId: string, text: string): void {
    JsonStorage.update<InterviewSession>('interviews', sessionId, {
      candidate_cv: { text, updated_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    });
  }

  /**
   * Append an entry to the session audit trail
   */
  static appendAudit(sessionId: string, entry: AuditEntry): void {
    const session = JsonStorage.load<InterviewSession>('interviews', sessionId);
    if (!session) throw new Error('Session not found');

    JsonStorage.update<InterviewSession>('interviews', sessionId, {
      audit_trail: [...(session.audit_trail || []), entry],
      updated_at: new Date().toISOString(),
    });
  }

  /**
   * Store scoring output on the session and move it to human review
   */
  static setScoring(
    sessionId: string,
    scoring: ScoringData,
    recommendation?: RecommendationData
  ): void {
    const update: Partial<InterviewSession> = {
      scoring,
      updated_at: new Date().toISOString(),
    };
    if (recommendation) update.recommendation = recommendation;
    if (scoring.status === 'completed') update.status = 'under_review';

    JsonStorage.update<InterviewSession>('interviews', sessionId, update);
  }

  /**
   * Record the outcome of a human review
   */
  static setReview(
    sessionId: string,
    status: InterviewSession['status'],
    review: HumanReviewData
  ): void {
    JsonStorage.update<InterviewSession>('interviews', sessionId, {
      status,
      human_review: review,
      // Retention runs from the decision, not from creation
      retention_until: retentionDeadline(),
      updated_at: new Date().toISOString(),
    });
  }

  /**
   * Replace the injection flags for a session (each scan overwrites the previous one)
   */
  static setInjectionFlags(sessionId: string, flags: InjectionFlag[]): void {
    const session = JsonStorage.load<InterviewSession>('interviews', sessionId);
    if (!session) throw new Error('Session not found');

    JsonStorage.update<InterviewSession>('interviews', sessionId, {
      security_flags: {
        ...(session.security_flags || {}),
        injection_attempts_detected: flags,
      },
      updated_at: new Date().toISOString(),
    });
  }
}
