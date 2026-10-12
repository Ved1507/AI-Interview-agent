/**
 * Human Review Routes
 * A person must approve or override every AI recommendation before a report is final.
 */

import { Router, Request, Response } from 'express';
import { InterviewSessionModel } from '../../database/models/InterviewSession';
import { ScoringResultModel } from '../../database/models/ScoringResult';
import { RecommendationModel } from '../../database/models/Recommendation';
import { JsonStorage } from '../../storage/JsonStorage';
import {
  HumanReviewData,
  InterviewSession,
  OverrideRecommendationRequest,
} from '../../types/interview.types';
import { Logger } from '../../utils/logger';

const router = Router();
const logger = new Logger('HumanReviewRoutes');

const LEVELS = ['strong_hire', 'hire', 'hold', 'no_hire'] as const;

/**
 * GET /api/v1/human-review/pending?limit=20
 * Scored interviews waiting for a human decision
 */
router.get('/pending', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 100);
    const sessions = JsonStorage.query<InterviewSession>(
      'interviews',
      (s) => s.status === 'under_review'
    )
      .sort((a, b) => new Date(b.completed_at || 0).getTime() - new Date(a.completed_at || 0).getTime())
      .slice(0, limit);

    res.json({
      sessions: sessions.map((s) => ({
        session_id: s.id,
        candidate_id: s.candidate_id,
        job_id: s.job_id,
        mode: s.mode,
        completed_at: s.completed_at || null,
        weighted_score: s.scoring?.weighted_score ?? null,
        recommendation: s.recommendation?.level ?? null,
        confidence: s.recommendation?.confidence ?? null,
        injection_flags: s.security_flags?.injection_attempts_detected?.length || 0,
      })),
    });
  } catch (error) {
    logger.error('Error listing pending reviews', { error });
    res.status(500).json({ error: 'Failed to list pending reviews' });
  }
});

/**
 * GET /api/v1/human-review/:sessionId
 * Full review view: transcript, scores, evidence, recommendation, audit trail
 */
router.get('/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const session = await InterviewSessionModel.getById(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Interview session not found' });
    }

    const scoring = await ScoringResultModel.getBySessionId(sessionId);
    const recommendation = await RecommendationModel.getBySessionId(sessionId);

    res.json({
      session_id: session.id,
      candidate_id: session.candidate_id,
      job_id: session.job_id,
      mode: session.mode,
      status: session.status,
      scoring_status: session.scoring?.status || 'pending',
      questions: session.questions,
      responses: session.responses,
      scoring,
      recommendation,
      security_flags: session.security_flags || { injection_attempts_detected: [] },
      human_review: session.human_review || null,
      audit_trail: session.audit_trail || [],
    });
  } catch (error) {
    logger.error('Error fetching review', { error });
    res.status(500).json({ error: 'Failed to fetch review' });
  }
});

/**
 * POST /api/v1/human-review/:sessionId/approve
 * Accept the AI recommendation without changes
 * Body: { reviewer_id, notes? }
 */
router.post('/:sessionId/approve', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { reviewer_id, notes } = req.body || {};

    if (!reviewer_id || typeof reviewer_id !== 'string') {
      return res.status(400).json({ error: 'reviewer_id is required' });
    }

    const session = await InterviewSessionModel.getById(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Interview session not found' });
    }
    if (session.status !== 'under_review') {
      return res.status(409).json({
        error: `Interview is not awaiting review (status: ${session.status})`,
      });
    }

    const timestamp = new Date().toISOString();
    const original = session.recommendation?.level;
    const review: HumanReviewData = {
      status: 'approved',
      reviewer_id,
      original_recommendation: original,
      final_recommendation: original,
      review_timestamp: timestamp,
      review_notes: typeof notes === 'string' ? notes : undefined,
    };

    InterviewSessionModel.setReview(sessionId, 'finalized', review);
    InterviewSessionModel.appendAudit(sessionId, {
      action: 'recommendation_approved',
      timestamp,
      user_id: reviewer_id,
      details: { recommendation: original, notes: review.review_notes },
    });

    res.json({ status: 'approved', report_ready: true });
    logger.info('Recommendation approved', { sessionId, reviewer_id });
  } catch (error) {
    logger.error('Error approving review', { error });
    res.status(500).json({ error: 'Failed to approve recommendation' });
  }
});

/**
 * POST /api/v1/human-review/:sessionId/override
 * Replace the AI recommendation. A written reason is required.
 * Body: { new_recommendation, reasoning, reviewer_id }
 */
router.post('/:sessionId/override', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const body = (req.body || {}) as Partial<OverrideRecommendationRequest>;

    if (!body.reviewer_id || typeof body.reviewer_id !== 'string') {
      return res.status(400).json({ error: 'reviewer_id is required' });
    }
    if (!body.new_recommendation || !(LEVELS as readonly string[]).includes(body.new_recommendation)) {
      return res.status(400).json({ error: 'new_recommendation must be strong_hire, hire, hold or no_hire' });
    }
    if (!body.reasoning || body.reasoning.trim().length < 10) {
      return res.status(400).json({ error: 'reasoning is required (at least 10 characters)' });
    }

    const session = await InterviewSessionModel.getById(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Interview session not found' });
    }
    if (session.status !== 'under_review') {
      return res.status(409).json({
        error: `Interview is not awaiting review (status: ${session.status})`,
      });
    }

    const timestamp = new Date().toISOString();
    const original = session.recommendation?.level;
    const review: HumanReviewData = {
      status: 'overridden',
      reviewer_id: body.reviewer_id,
      original_recommendation: original,
      final_recommendation: body.new_recommendation,
      override_reason: body.reasoning.trim(),
      review_timestamp: timestamp,
    };

    InterviewSessionModel.setReview(sessionId, 'finalized', review);
    InterviewSessionModel.appendAudit(sessionId, {
      action: 'recommendation_overridden',
      timestamp,
      user_id: body.reviewer_id,
      details: {
        from: original,
        to: body.new_recommendation,
        reasoning: review.override_reason,
      },
    });

    res.json({
      updated_recommendation: body.new_recommendation,
      audit_trail_id: `${sessionId}:${timestamp}`,
    });
    logger.info('Recommendation overridden', { sessionId, reviewer_id: body.reviewer_id });
  } catch (error) {
    logger.error('Error overriding recommendation', { error });
    res.status(500).json({ error: 'Failed to override recommendation' });
  }
});

export default router;
