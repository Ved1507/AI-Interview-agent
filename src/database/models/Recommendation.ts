/**
 * Recommendation Model
 * Handles storage and retrieval of hiring recommendations
 */

import { JsonStorage } from '../../storage/JsonStorage';
import { RecommendationData } from '../../types/interview.types';
import { Logger } from '../../utils/logger';
import { v4 as uuidv4 } from 'uuid';

const logger = new Logger('Recommendation');

interface RecommendationRecord extends RecommendationData {
  id: string;
  session_id: string;
  created_at: string;
}

export class RecommendationModel {
  /**
   * Create a recommendation for a session
   */
  static async create(
    sessionId: string,
    recommendation: RecommendationData
  ): Promise<string> {
    try {
      const record: RecommendationRecord = {
        ...recommendation,
        id: uuidv4(),
        session_id: sessionId,
        created_at: new Date().toISOString(),
      };

      JsonStorage.save('recommendations', record);

      logger.info('Recommendation created', {
        sessionId,
        id: record.id,
        level: recommendation.level,
        confidence: recommendation.confidence,
      });

      return record.id;
    } catch (error) {
      logger.error('Failed to create recommendation', { error, sessionId });
      throw error;
    }
  }

  /**
   * Get recommendation by session ID
   */
  static async getBySessionId(sessionId: string): Promise<RecommendationData | null> {
    try {
      const records = JsonStorage.query<RecommendationRecord>(
        'recommendations',
        (r) => r.session_id === sessionId
      );
      if (records.length === 0) return null;

      const record = records[0];
      return {
        level: record.level,
        confidence: record.confidence,
        reasoning: record.reasoning,
        strengths: record.strengths,
        growth_areas: record.growth_areas,
        timestamp: record.created_at,
      };
    } catch (error) {
      logger.error('Failed to get recommendation', { error, sessionId });
      return null;
    }
  }

  /**
   * Calculate confidence based on dimension variance
   */
  static calculateConfidence(
    dimensionScores: number[]
  ): 'high' | 'medium' | 'low' {
    if (dimensionScores.length === 0) {
      return 'low';
    }

    // Calculate standard deviation
    const mean = dimensionScores.reduce((a, b) => a + b, 0) / dimensionScores.length;
    const variance =
      dimensionScores.reduce((sum, score) => sum + Math.pow(score - mean, 2), 0) /
      dimensionScores.length;
    const stdDev = Math.sqrt(variance);

    // High confidence: low variance (std dev < 10)
    // Medium confidence: moderate variance (std dev 10-20)
    // Low confidence: high variance (std dev > 20)
    if (stdDev < 10) {
      return 'high';
    } else if (stdDev < 20) {
      return 'medium';
    } else {
      return 'low';
    }
  }

}
