/**
 * Candidate routes: /api/v1/candidate/:token/...
 * The token is the only credential. It maps to one session, and only the candidate's steps are allowed.
 * Each allowed step is forwarded to the same handler the admin uses, so the interview logic exists only once.
 */

import express, { NextFunction, Request, Response } from 'express';
import interviewRoutes, { finishSession } from './interviewRoutes';
import { getJobSummary } from './jobRoutes';
import { findSessionByLinkToken } from '../../invitations/candidateLink';
import { InterviewSessionModel } from '../../database/models/InterviewSession';
import { getConfig } from '../../config/env';
import { InterviewSession } from '../../types/interview.types';
import { Logger } from '../../utils/logger';

const logger = new Logger('CandidateRoutes');
const router = express.Router({ mergeParams: true });

type LinkState = 'open' | 'in_progress' | 'expired' | 'submitted' | 'not_found';

const SUBMITTED_STATUSES = ['completed', 'under_review', 'finalized'];

const MESSAGES: Record<LinkState, string> = {
  open: 'This step is not available right now.',
  in_progress: 'This step is not available right now.',
  expired: 'This link has expired. Please ask for a new one.',
  submitted: 'Your interview has been submitted. Thank you.',
  not_found: 'This link is not valid.',
};

/** The link's state from the session. Joining = the interview has started. */
function linkState(session: InterviewSession): { state: LinkState; expires_at?: string; interview_ends_at?: string } {
  if (SUBMITTED_STATUSES.includes(session.status)) return { state: 'submitted' };

  if (session.status === 'in_progress' && session.started_at) {
    const endsAt = new Date(session.started_at).getTime() + getConfig().interviewTimeoutMinutes * 60 * 1000;
    return { state: 'in_progress', interview_ends_at: new Date(endsAt).toISOString() };
  }

  // Not joined yet: the join window applies
  const expiresAt = session.candidate_link?.expires_at || new Date(0).toISOString();
  if (Date.now() > new Date(expiresAt).getTime()) return { state: 'expired', expires_at: expiresAt };
  return { state: 'open', expires_at: expiresAt };
}

/** Resolve the token once per request. Unknown tokens get a plain "not valid" answer. */
router.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = String(req.params.token || '');
    const session = await findSessionByLinkToken(token);
    if (!session) {
      return res.status(404).json({ state: 'not_found', error: MESSAGES.not_found });
    }

    let info = linkState(session);

    // The interview ran past its time limit: submit what was answered, then refuse further steps
    if (info.state === 'in_progress' && info.interview_ends_at && Date.now() > new Date(info.interview_ends_at).getTime()) {
      logger.info('Interview time limit reached, submitting', { sessionId: session.id });
      await finishSession(session.id, 'time_limit');
      info = { state: 'submitted' };
    }

    (req as any).candidate = { session, ...info };
    next();
  } catch (error) {
    logger.error('Candidate link check failed', { error });
    res.status(500).json({ error: 'Could not check the link' });
  }
});

function refuse(res: Response, state: LinkState) {
  return res.status(410).json({ state, error: MESSAGES[state] });
}

/** Current state, with what the page needs to show. The candidate's own session is the only source. */
router.get('/status', (req: Request, res: Response) => {
  const { session, state, expires_at, interview_ends_at } = (req as any).candidate;
  const job = getJobSummary(session.job_id);
  res.json({
    state,
    expires_at: state === 'open' ? expires_at : undefined,
    interview_ends_at: state === 'in_progress' ? interview_ends_at : undefined,
    time_limit_minutes: getConfig().interviewTimeoutMinutes,
    job_title: job ? job.title : null,
    client_name: getConfig().clientName || null,
    mode: session.mode,
    consented: session.consent?.third_party_ai === true && !!session.consent?.timestamp,
    has_cv: !!session.candidate_cv?.text,
    message: state === 'open' || state === 'in_progress' ? undefined : MESSAGES[state as LinkState],
  });
});

/** Consent: the candidate must agree to all three statements before starting */
router.post('/consent', async (req: Request, res: Response) => {
  const { session, state } = (req as any).candidate;
  if (state !== 'open') return refuse(res, state);

  const body = req.body || {};
  if (body.data_storage !== true || body.third_party_ai !== true || body.ai_agent_notice !== true) {
    return res.status(400).json({ error: 'All consent statements must be accepted' });
  }

  await InterviewSessionModel.addConsent(session.id, {
    data_storage: true,
    third_party_ai: true,
    ai_agent_notice: true,
  });
  InterviewSessionModel.appendAudit(session.id, {
    action: 'consent_recorded',
    timestamp: new Date().toISOString(),
    user_id: 'candidate',
    details: {},
  });
  res.json({ consented: true });
});

/** Steps forwarded to the shared interview handlers, each with the link states it is allowed in */
function forward(target: (sessionId: string) => string, allowed: LinkState[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const { session, state } = (req as any).candidate;
    if (!allowed.includes(state)) return refuse(res, state);

    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    req.url = `${target(session.id)}${query}`;
    (interviewRoutes as any)(req, res, next);
  };
}

router.post('/start', forward((id) => `/${id}/start`, ['open']));
router.post('/cv/upload', forward((id) => `/${id}/cv/upload`, ['open', 'in_progress']));
router.put('/cv', forward((id) => `/${id}/cv`, ['open', 'in_progress']));
router.get('/next-question', forward((id) => `/${id}/next-question`, ['in_progress']));
router.post('/submit-answer', forward((id) => `/${id}/submit-answer`, ['in_progress']));
router.post('/submit-follow-up', forward((id) => `/${id}/submit-follow-up`, ['in_progress']));
router.post('/complete', forward((id) => `/${id}/complete`, ['in_progress']));

export default router;
