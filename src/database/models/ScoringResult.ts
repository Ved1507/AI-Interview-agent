/**
 * ScoringResult Model
 * Handles storage and retrieval of interview scoring results
 */

import { JsonStorage } from '../../storage/JsonStorage';
import { ScoringData, DimensionScore } from '../../types/interview.types';
import { Logger } from '../../utils/logger';

const logger = new Logger('ScoringResult');

interface ScoringRecord extends ScoringData {
  id: string;
  session_id: string;
  created_at: string;
  updated_at: string;
}

export class ScoringResultModel {
  /**
   * Create or update scoring results for a session
   */
  static async upsert(
    sessionId: string,
    scoring: ScoringData
  ): Promise<string> {
    try {
      const existing = JsonStorage.load<ScoringRecord>(
        'scoring',
        sessionId
      );

      // Keyed by session ID so getBySessionId can load it directly
      const record: ScoringRecord = {
        ...scoring,
        id: sessionId,
        session_id: sessionId,
        created_at: existing?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      JsonStorage.save('scoring', record);

      if (existing) {
        logger.info('Scoring results updated', { sessionId, id: record.id });
      } else {
        logger.info('Scoring results created', { sessionId, id: record.id });
      }

      return record.id;
    } catch (error) {
      logger.error('Failed to upsert scoring results', { error, sessionId });
      throw error;
    }
  }

  /**
   * Get scoring results for a session
   */
  static async getBySessionId(sessionId: string): Promise<ScoringData | null> {
    try {
      const record = JsonStorage.load<ScoringRecord>('scoring', sessionId);
      if (!record) return null;

      return {
        status: record.status,
        dimensions: record.dimensions,
        weighted_score: record.weighted_score,
        scoring_timestamp: record.created_at,
      };
    } catch (error) {
      logger.error('Failed to get scoring results', { error, sessionId });
      return null;
    }
  }

  /**
   * Calculate weighted score from dimension scores
   */
  static calculateWeightedScore(dimensions: {
    technical_skills?: DimensionScore;
    domain_understanding?: DimensionScore;
    problem_solving?: DimensionScore;
    communication?: DimensionScore;
    overall_fit?: DimensionScore;
  }): number {
    // Weights
    const weights = {
      technical_skills: 0.4,
      domain_understanding: 0.2,
      problem_solving: 0.2,
      communication: 0.1,
    };

    let totalScore = 0;
    let totalWeight = 0;

    if (dimensions.technical_skills) {
      totalScore += dimensions.technical_skills.score * weights.technical_skills;
      totalWeight += weights.technical_skills;
    }

    if (dimensions.domain_understanding) {
      totalScore += dimensions.domain_understanding.score * weights.domain_understanding;
      totalWeight += weights.domain_understanding;
    }

    if (dimensions.problem_solving) {
      totalScore += dimensions.problem_solving.score * weights.problem_solving;
      totalWeight += weights.problem_solving;
    }

    if (dimensions.communication) {
      totalScore += dimensions.communication.score * weights.communication;
      totalWeight += weights.communication;
    }

    if (totalWeight === 0) {
      return 0;
    }

    return Math.round((totalScore / totalWeight) * 100) / 100;
  }
}
