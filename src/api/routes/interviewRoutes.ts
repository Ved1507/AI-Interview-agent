/**
 * Interview API Routes
 * Endpoints for interview flow management
 */

import { Router, Request, Response } from 'express';
import { InterviewSessionModel } from '../../database/models/InterviewSession';
import { ScoringResultModel } from '../../database/models/ScoringResult';
import { RecommendationModel } from '../../database/models/Recommendation';
import {
  InitializeInterviewRequest,
  InitializeInterviewResponse,
  FollowUpResponse,
  InterviewSession,
  QuestionInstance,
  ResponseData,
  SubmitAnswerRequest,
  SubmitAnswerResponse,
} from '../../types/interview.types';
import { getJobContext, loadQuestionsForJob } from './jobRoutes';
import {
  followUpsFor,
  isAnswered,
  isFollowUp,
  mainQuestions,
  nextItem,
} from '../../interview/InterviewFlow';
import { planCvProbes, planNextFollowUp } from '../../interview/followUpEngine';
import { extractClaims } from '../../interview/cvClaims';
import { generateInterviewQuestions } from '../../interview/questionGenerator';
import { issueCandidateLink } from '../../invitations/candidateLink';
import { getConfig } from '../../config/env';
import { JsonStorage } from '../../storage/JsonStorage';
import { getJobSummary } from './jobRoutes';
import { ScoringEngine } from '../../scoring/ScoringEngine';
import { CV_MAX_BYTES, extractCvText } from '../../cv/cvExtractor';
import { InjectionScanner } from '../../security/InjectionScanner';
import { Logger } from '../../utils/logger';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
const logger = new Logger('InterviewRoutes');
const MAX_CV_CHARS = 50000;

/**
 * Run the scoring engine and store the outcome on the session.
 * Failures are recorded as scoring status 'error' rather than thrown.
 */
async function runScoring(sessionId: string, jobId: string): Promise<void> {
  // Injection scan runs first so the reviewer sees flags alongside the scores.
  // A scan failure is logged and never blocks scoring.
  try {
    await InjectionScanner.scanSession(sessionId);
  } catch (error) {
    logger.error('Injection scan failed', { sessionId, error: error instanceof Error ? error.message : error });
  }

  try {
    const session = await InterviewSessionModel.getById(sessionId);
    const { scoring, recommendation } = await ScoringEngine.scoreInterview(
      sessionId,
      getJobContext(jobId),
      session?.candidate_cv?.text
    );
    InterviewSessionModel.setScoring(sessionId, { ...scoring, status: 'completed' }, recommendation);
    InterviewSessionModel.appendAudit(sessionId, {
      action: 'scoring_completed',
      timestamp: new Date().toISOString(),
      user_id: 'system',
      details: { weighted_score: scoring.weighted_score, level: recommendation.level },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown scoring error';
    logger.error('Scoring failed', { sessionId, error: message });
    InterviewSessionModel.setScoring(sessionId, { status: 'error' });
    InterviewSessionModel.appendAudit(sessionId, {
      action: 'scoring_failed',
      timestamp: new Date().toISOString(),
      user_id: 'system',
      details: { message },
    });
    return;
  }

  // The report is not generated here. The admin generates it on request from the admin portal.
}

/**
 * Store the CV text, then scan it for prompt injection.
 * The scan never blocks the upload; a flagged CV goes to the reviewer.
 */
async function storeCv(sessionId: string, text: string): Promise<void> {
  InterviewSessionModel.setCv(sessionId, text);
  try {
    await InjectionScanner.scanCv(sessionId, text);
  } catch (error) {
    logger.error('CV injection scan failed', { sessionId, error: error instanceof Error ? error.message : error });
  }

  // Modes B and C: extract claims from the CV for follow-ups, probes and generated questions
  const session = await InterviewSessionModel.getById(sessionId);
  if (session?.mode === 'B' || session?.mode === 'C') {
    try {
      const claims = await extractClaims(sessionId, text);
      InterviewSessionModel.setCvClaims(sessionId, claims);
      InterviewSessionModel.appendAudit(sessionId, {
        action: 'cv_claims_extracted',
        timestamp: new Date().toISOString(),
        user_id: 'system',
        details: { count: claims.length },
      });
    } catch (error) {
      logger.warn('CV claim extraction unavailable', { sessionId });
      InterviewSessionModel.appendAudit(sessionId, {
        action: 'cv_claims_unavailable',
        timestamp: new Date().toISOString(),
        user_id: 'system',
        details: {},
      });
    }
  }
}


/**
 * POST /api/v1/interviews/initialize
 * Initialize a new interview session
 */
router.post('/initialize', async (req: Request, res: Response) => {
  try {
    const body: InitializeInterviewRequest = req.body;

    // Validate required fields
    if (!body.candidate_id || !body.job_id || !body.mode) {
      return res.status(400).json({
        error: 'Missing required fields: candidate_id, job_id, mode',
      });
    }

    if (!['A', 'B', 'C'].includes(body.mode)) {
      return res.status(400).json({
        error: 'Invalid mode. Must be A, B, or C',
      });
    }

    const cvText = typeof body.cv_text === 'string' ? body.cv_text.trim() : '';
    if (cvText.length > MAX_CV_CHARS) {
      return res.status(400).json({ error: `CV text is too long (max ${MAX_CV_CHARS} characters)` });
    }

    // Load the question bank for this job and mode
    const bank = loadQuestionsForJob(body.job_id, body.mode);
    if (bank === null) {
      return res.status(400).json({
        error: `Unknown job_id: ${body.job_id}`,
      });
    }

    // Create session
    const session = await InterviewSessionModel.create({
      candidate_id: body.candidate_id,
      job_id: body.job_id,
      mode: body.mode,
    });

    // Add consent if provided
    if (body.consent) {
      await InterviewSessionModel.addConsent(session.id, body.consent);
    }

    // Attach question-bank questions to the session (Mode B/C CV-based questions not yet generated)
    // Mode C writes its own questions from the CV when the interview starts, so no bank questions are attached
    const bankForMode = body.mode === 'C' ? [] : bank;
    const questions: QuestionInstance[] = bankForMode.map((q, index) => ({
      id: `qi_${session.id}_${index + 1}`,
      question_id: q.id,
      text: q.text,
      order: index + 1,
      skill_area: q.skill_area,
      difficulty: q.difficulty,
      rubric: q.scoring_rubric,
      generated_by_mode: 'question_bank',
      timestamp: new Date().toISOString(),
    }));
    InterviewSessionModel.setQuestions(session.id, questions);

    if (cvText) {
      await storeCv(session.id, cvText);
    }

    InterviewSessionModel.appendAudit(session.id, {
      action: 'interview_initialized',
      timestamp: new Date().toISOString(),
      user_id: 'system',
      details: { mode: body.mode, job_id: body.job_id, questions: questions.length },
    });

    const response: InitializeInterviewResponse = {
      session_id: session.id,
      questions_count: questions.length,
      estimated_duration_minutes: questions.length * 5,
    };

    logger.info('Interview initialized', { sessionId: session.id });
    res.status(201).json(response);
  } catch (error) {
    logger.error('Error initializing interview', { error });
    res.status(500).json({
      error: 'Failed to initialize interview',
    });
  }
});

/**
 * GET /api/v1/interviews/:sessionId
 * Get interview session details
 */
router.get('/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    const session = await InterviewSessionModel.getById(sessionId);

    if (!session) {
      return res.status(404).json({
        error: 'Interview session not found',
      });
    }

    res.json(session);
  } catch (error) {
    logger.error('Error fetching interview', { error });
    res.status(500).json({
      error: 'Failed to fetch interview session',
    });
  }
});

/**
 * GET /api/v1/interviews/:sessionId/status
 * Get interview status
 */
router.get('/:sessionId/status', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    const session = await InterviewSessionModel.getById(sessionId);

    if (!session) {
      return res.status(404).json({
        error: 'Interview session not found',
      });
    }

    res.json({
      session_id: session.id,
      status: session.status,
      progress: {
        questions_answered: session.responses?.length || 0,
        current_question: (session.responses?.length || 0) + 1,
      },
      duration_minutes: session.total_duration_minutes || 0,
    });
  } catch (error) {
    logger.error('Error fetching interview status', { error });
    res.status(500).json({
      error: 'Failed to fetch interview status',
    });
  }
});

/**
 * POST /api/v1/interviews/:sessionId/start
 * Start interview (set to in_progress)
 */
router.post('/:sessionId/start', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    const session = await InterviewSessionModel.getById(sessionId);
    if (!session) {
      return res.status(404).json({
        error: 'Interview session not found',
      });
    }

    // Consent must be recorded before the interview can begin
    if (!session.consent?.timestamp) {
      return res.status(403).json({
        error: 'Candidate consent is required before starting the interview',
      });
    }
    if (session.consent.third_party_ai !== true) {
      return res.status(403).json({
        error: 'The candidate must consent to their CV and answers being sent to OpenAI before the interview starts',
      });
    }

    // Mode C: generate the questions from the CV and job now. Nothing starts if this fails.
    if (session.mode === 'C' && !session.questions.some((q) => q.generated_by_mode === 'cv_driven')) {
      if (!session.candidate_cv?.text) {
        return res.status(400).json({ error: 'Mode C needs the candidate CV before the interview starts' });
      }
      try {
        await generateInterviewQuestions(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Question generation failed';
        logger.error('Mode C question generation failed', { sessionId, error: message });
        return res.status(503).json({ error: `Could not prepare the interview questions. ${message}` });
      }
    }

    await InterviewSessionModel.start(sessionId);
    InterviewSessionModel.appendAudit(sessionId, {
      action: 'interview_started',
      timestamp: new Date().toISOString(),
      user_id: 'system',
      details: { consent_timestamp: session.consent.timestamp },
    });

    // Mode B: plan CV-specific questions now, so the interview length is fixed from the start
    await planCvProbes(sessionId);

    res.json({
      session_id: sessionId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
    });

    logger.info('Interview started', { sessionId });
  } catch (error) {
    logger.error('Error starting interview', { error });
    res.status(500).json({
      error: 'Failed to start interview',
    });
  }
});

/**
 * POST /api/v1/interviews/:sessionId/submit-answer
 * Submit candidate answer
 */
router.post('/:sessionId/submit-answer', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const body: SubmitAnswerRequest = req.body;

    const session = await InterviewSessionModel.getById(sessionId);
    if (!session) {
      return res.status(404).json({
        error: 'Interview session not found',
      });
    }

    if (session.status !== 'in_progress') {
      return res.status(409).json({
        error: `Interview is not in progress (status: ${session.status})`,
      });
    }

    const question = session.questions.find(
      (q) => q.id === body.question_id || q.question_id === body.question_id
    );
    if (!question) {
      return res.status(400).json({ error: 'Unknown question_id' });
    }
    if (isFollowUp(question)) {
      return res.status(400).json({ error: 'Send follow-up answers to submit-follow-up' });
    }
    if (session.responses.some((r) => r.question_instance_id === question.id)) {
      return res.status(409).json({ error: 'Question already answered' });
    }
    const current = nextItem(session);
    if (current && current.id !== question.id) {
      return res.status(409).json({ error: 'Answer the current question first' });
    }

    const recorded: ResponseData = {
      id: uuidv4(),
      question_instance_id: question.id,
      transcript: body.transcript || '',
      duration_seconds: body.duration_seconds || 0,
      timestamp: new Date().toISOString(),
    };
    InterviewSessionModel.addResponse(sessionId, recorded);
    InterviewSessionModel.appendAudit(sessionId, {
      action: 'answer_submitted',
      timestamp: recorded.timestamp,
      user_id: 'system',
      details: { question_id: question.id, duration_seconds: recorded.duration_seconds },
    });

    // Mode B: decide whether this answer needs a follow-up. Other modes skip this.
    await planNextFollowUp(sessionId, question.id, question.text, recorded.transcript);
    const updated = (await InterviewSessionModel.getById(sessionId)) || session;
    const next = nextItem(updated);

    const response: SubmitAnswerResponse = {
      recorded: true,
      follow_ups_available: followUpsFor(updated, question.id).filter((f) => !isAnswered(updated, f)).length,
      next_question: next || undefined,
    };

    res.json(response);
    logger.info('Answer submitted', { sessionId, questionId: question.id });
  } catch (error) {
    logger.error('Error submitting answer', { error });
    res.status(500).json({
      error: 'Failed to submit answer',
    });
  }
});

/**
 * POST /api/v1/interviews/:sessionId/submit-follow-up
 * Record the candidate's answer to a follow-up question
 * Body: { question_id, transcript, duration_seconds }
 */
router.post('/:sessionId/submit-follow-up', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const body: SubmitAnswerRequest = req.body || ({} as SubmitAnswerRequest);

    const session = await InterviewSessionModel.getById(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Interview session not found' });
    }
    if (session.status !== 'in_progress') {
      return res.status(409).json({ error: `Interview is not in progress (status: ${session.status})` });
    }

    const followUp = session.questions.find((q) => q.id === body.question_id);
    if (!followUp || !isFollowUp(followUp) || !followUp.parent_question_id) {
      return res.status(400).json({ error: 'Unknown follow-up question_id' });
    }
    if (isAnswered(session, followUp)) {
      return res.status(409).json({ error: 'Follow-up already answered' });
    }
    const current = nextItem(session);
    if (current && current.id !== followUp.id) {
      return res.status(409).json({ error: 'Answer the current question first' });
    }

    const parent = session.responses.find((r) => r.question_instance_id === followUp.parent_question_id);
    const record: FollowUpResponse = {
      id: uuidv4(),
      text: followUp.text,
      trigger: followUp.trigger,
      transcript: body.transcript || '',
      duration_seconds: body.duration_seconds || 0,
      order: (parent?.follow_ups?.length || 0) + 1,
      question_instance_id: followUp.id,
    };
    InterviewSessionModel.addFollowUpResponse(sessionId, followUp.parent_question_id, record);
    InterviewSessionModel.appendAudit(sessionId, {
      action: 'follow_up_submitted',
      timestamp: new Date().toISOString(),
      user_id: 'system',
      details: { parent_question_id: followUp.parent_question_id, trigger: followUp.trigger },
    });

    // Mode B: a follow-up answer can prompt another follow-up, up to the cap
    const parentQuestion = session.questions.find((q) => q.id === followUp.parent_question_id);
    await planNextFollowUp(
      sessionId,
      followUp.parent_question_id,
      `${parentQuestion?.text || ''} Follow-up: ${followUp.text}`,
      record.transcript,
      true
    );
    const updated = (await InterviewSessionModel.getById(sessionId)) || session;
    res.json({ recorded: true, next_question: nextItem(updated) || undefined });
  } catch (error) {
    logger.error('Error submitting follow-up', { error });
    res.status(500).json({ error: 'Failed to submit follow-up' });
  }
});

/**
 * Mark an interview as completed and start scoring in the background.
 * Used by the candidate's submit button, by the automatic submit when the time limit runs out, and by the admin.
 */
const finishing = new Set<string>();

export async function finishSession(
  sessionId: string,
  by: 'candidate' | 'time_limit' | 'admin'
): Promise<boolean> {
  // Only one finish per interview at a time, and only for interviews still in progress
  if (finishing.has(sessionId)) return false;
  finishing.add(sessionId);
  try {
    const current = await InterviewSessionModel.getById(sessionId);
    if (!current || current.status !== 'in_progress') return false;

    await InterviewSessionModel.complete(sessionId);
    InterviewSessionModel.appendAudit(sessionId, {
      action: 'interview_completed',
      timestamp: new Date().toISOString(),
      user_id: by === 'admin' ? 'admin' : 'system',
      details: { responses: current.responses.length, by },
    });

    if (current.responses.length === 0) {
      // Nothing to score: record the reason instead of sending an empty interview to the model
      InterviewSessionModel.setScoring(sessionId, { status: 'error' });
      InterviewSessionModel.appendAudit(sessionId, {
        action: 'scoring_failed',
        timestamp: new Date().toISOString(),
        user_id: 'system',
        details: { message: 'No answers were recorded' },
      });
      return true;
    }

    // Scoring calls the LLM and can take a while, so it runs in the background
    InterviewSessionModel.setScoring(sessionId, { status: 'in_progress' });
    runScoring(sessionId, current.job_id);
    return true;
  } finally {
    finishing.delete(sessionId);
  }
}

/**
 * Submit every interview that has run past its time limit.
 * Runs on a timer, so it works even when the candidate has closed the page.
 */
export async function submitExpiredInterviews(now: number = Date.now()): Promise<number> {
  const limitMs = getConfig().interviewTimeoutMinutes * 60 * 1000;
  const expired = JsonStorage.query<InterviewSession>(
    'interviews',
    (s) => s.status === 'in_progress' && !!s.started_at && now - new Date(s.started_at).getTime() > limitMs
  );

  let submitted = 0;
  for (const session of expired) {
    if (await finishSession(session.id, 'time_limit')) submitted++;
  }
  if (submitted > 0) {
    logger.info('Interviews past their time limit were submitted', { count: submitted });
  }
  return submitted;
}

/**
 * POST /api/v1/interviews/:sessionId/complete
 * Complete interview and trigger scoring
 */
router.post('/:sessionId/complete', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    const session = await InterviewSessionModel.getById(sessionId);
    if (!session) {
      return res.status(404).json({
        error: 'Interview session not found',
      });
    }

    if (session.responses.length === 0) {
      return res.status(409).json({
        error: 'No answers have been recorded, so there is nothing to score',
      });
    }

    await finishSession(sessionId, 'candidate');

    res.json({
      session_id: sessionId,
      status: 'completed',
      scoring_status: 'in_progress',
    });

    logger.info('Interview completed', { sessionId });
  } catch (error) {
    logger.error('Error completing interview', { error });
    res.status(500).json({
      error: 'Failed to complete interview',
    });
  }
});

/**
 * GET /api/v1/interviews
 * Recent interviews for the admin list (newest first)
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
    const sessions = JsonStorage.query<InterviewSession>('interviews', () => true)
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, limit);

    res.json({
      interviews: sessions.map((s) => {
        const job = getJobSummary(s.job_id);
        return {
          session_id: s.id,
          candidate_id: s.candidate_id,
          job_title: job ? job.title : s.job_id,
          mode: s.mode,
          status: s.status,
          created_at: s.created_at || null,
          link_expires_at: s.candidate_link?.expires_at || null,
          joined: s.status !== 'initialized',
          scoring_status: s.scoring?.status || 'pending',
        };
      }),
    });
  } catch (error) {
    logger.error('Error listing interviews', { error });
    res.status(500).json({ error: 'Failed to list interviews' });
  }
});

/**
 * POST /api/v1/interviews/:sessionId/link
 * Create (or replace) the candidate's join link. Valid for LINK_LIFETIME_MINUTES (at most 30).
 * Refused once the candidate has joined, so a running interview is never cut off.
 */
router.post('/:sessionId/link', async (req: Request, res: Response) => {
  try {
    const session = await InterviewSessionModel.getById(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Interview session not found' });
    }
    if (session.status !== 'initialized') {
      return res.status(409).json({ error: 'The candidate has already joined, so the link cannot be replaced' });
    }

    const { token, expires_at } = issueCandidateLink(session.id);
    const config = getConfig();
    InterviewSessionModel.appendAudit(session.id, {
      action: 'candidate_link_created',
      timestamp: new Date().toISOString(),
      user_id: 'admin',
      details: { expires_at },
    });

    res.status(201).json({
      session_id: session.id,
      url: `${config.publicBaseUrl}/i/${token}`,
      expires_at,
      lifetime_minutes: config.linkLifetimeMinutes,
    });
  } catch (error) {
    logger.error('Error creating candidate link', { error });
    res.status(500).json({ error: 'Failed to create the link' });
  }
});

/**
 * POST /api/v1/interviews/:sessionId/rescore
 * Run scoring again for a completed interview whose scoring failed (e.g. the AI service was unavailable)
 */
router.post('/:sessionId/rescore', async (req: Request, res: Response) => {
  try {
    const session = await InterviewSessionModel.getById(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Interview session not found' });
    }
    if (session.status !== 'completed' && session.status !== 'under_review') {
      return res.status(409).json({ error: `Only completed interviews can be scored (status: ${session.status})` });
    }
    if (session.scoring?.status === 'completed') {
      return res.status(409).json({ error: 'This interview has already been scored' });
    }
    if (session.responses.length === 0) {
      return res.status(409).json({ error: 'No answers were recorded, so there is nothing to score' });
    }

    InterviewSessionModel.setScoring(session.id, { status: 'in_progress' });
    InterviewSessionModel.appendAudit(session.id, {
      action: 'scoring_retried',
      timestamp: new Date().toISOString(),
      user_id: 'system',
      details: {},
    });
    runScoring(session.id, session.job_id);

    res.status(202).json({ session_id: session.id, scoring_status: 'in_progress' });
  } catch (error) {
    logger.error('Error starting rescore', { error });
    res.status(500).json({ error: 'Failed to start scoring' });
  }
});

// Loaded with require: the multer package ships no TypeScript declarations
const multer = require('multer');
const cvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CV_MAX_BYTES, files: 1 },
});

/**
 * POST /api/v1/interviews/:sessionId/cv/upload
 * Upload a PDF or DOCX CV (multipart field "file"). Only the extracted text is stored.
 */
router.post(
  '/:sessionId/cv/upload',
  (req: Request, res: Response, next) => {
    cvUpload.single('file')(req, res, (err: any) => {
      if (err) {
        const message = err.code === 'LIMIT_FILE_SIZE' ? 'The CV file is larger than 5 MB.' : 'The upload failed.';
        return res.status(400).json({ error: message });
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    try {
      const session = await InterviewSessionModel.getById(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Interview session not found' });
      }
      if (session.status !== 'initialized' && session.status !== 'in_progress') {
        return res.status(409).json({ error: 'A CV can only be uploaded before the interview is complete' });
      }

      const file = (req as any).file;
      if (!file) {
        return res.status(400).json({ error: 'Attach the CV as the form field "file"' });
      }

      const { text, fileType } = await extractCvText(file.buffer, file.originalname);
      await storeCv(session.id, text);

      // Log the type and size only; the file name and content stay out of the audit trail
      InterviewSessionModel.appendAudit(session.id, {
        action: 'cv_uploaded',
        timestamp: new Date().toISOString(),
        user_id: 'system',
        details: { file_type: fileType, characters: text.length },
      });

      res.json({ session_id: session.id, file_type: fileType, cv_characters: text.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not read the CV';
      logger.warn('CV upload rejected', { sessionId: req.params.sessionId, reason: message });
      res.status(422).json({ error: message });
    }
  }
);

/**
 * PUT /api/v1/interviews/:sessionId/cv
 * Add or replace the candidate CV text. Locked once the interview is complete.
 */
router.put('/:sessionId/cv', async (req: Request, res: Response) => {
  try {
    const session = await InterviewSessionModel.getById(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Interview session not found' });
    }
    if (session.status === 'completed' || session.status === 'under_review' || session.status === 'finalized') {
      return res.status(409).json({ error: 'The CV cannot be changed after the interview is complete' });
    }

    const cvText = typeof req.body?.cv_text === 'string' ? req.body.cv_text.trim() : '';
    if (!cvText) {
      return res.status(400).json({ error: 'cv_text is required' });
    }
    if (cvText.length > MAX_CV_CHARS) {
      return res.status(400).json({ error: `CV text is too long (max ${MAX_CV_CHARS} characters)` });
    }

    await storeCv(session.id, cvText);
    // Log the size only; the CV itself is personal data and stays out of the audit trail
    InterviewSessionModel.appendAudit(session.id, {
      action: 'cv_provided',
      timestamp: new Date().toISOString(),
      user_id: 'system',
      details: { characters: cvText.length },
    });

    res.json({ session_id: session.id, cv_characters: cvText.length });
  } catch (error) {
    logger.error('Error saving CV', { error });
    res.status(500).json({ error: 'Failed to save CV' });
  }
});

/**
 * GET /api/v1/interviews/:sessionId/next-question
 * Next question that has not been answered yet
 */
router.get('/:sessionId/next-question', async (req: Request, res: Response) => {
  try {
    const session = await InterviewSessionModel.getById(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Interview session not found' });
    }

    const next = nextItem(session);
    const main = mainQuestions(session);
    res.json({
      question: next,
      kind: next ? (isFollowUp(next) ? 'follow_up' : 'question') : null,
      parent_question_id: next?.parent_question_id ?? null,
      // Progress counts the main track only; follow-ups are reported separately
      total_questions: main.length,
      answered: main.filter((q) => isAnswered(session, q)).length,
      follow_ups_answered: session.questions.filter((q) => isFollowUp(q) && isAnswered(session, q)).length,
    });
  } catch (error) {
    logger.error('Error fetching next question', { error });
    res.status(500).json({ error: 'Failed to fetch next question' });
  }
});

/**
 * GET /api/v1/interviews/:sessionId/results
 * Get interview results (scoring and recommendation)
 */
router.get('/:sessionId/results', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    const session = await InterviewSessionModel.getById(sessionId);
    if (!session) {
      return res.status(404).json({
        error: 'Interview session not found',
      });
    }

    const scoring = await ScoringResultModel.getBySessionId(sessionId);
    const recommendation = await RecommendationModel.getBySessionId(sessionId);

    res.json({
      session_id: sessionId,
      status: session.status,
      scoring_status: session.scoring?.status || 'pending',
      scoring,
      recommendation,
      human_review: session.human_review || null,
    });
  } catch (error) {
    logger.error('Error fetching results', { error });
    res.status(500).json({
      error: 'Failed to fetch interview results',
    });
  }
});

export default router;
