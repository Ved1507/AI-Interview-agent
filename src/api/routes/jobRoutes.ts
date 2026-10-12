/**
 * Job & Question Bank Routes
 * Job descriptions are Markdown files (data/job_descriptions/*.md).
 * Question banks are JSON files (data/question_banks/*.json).
 */

import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { Logger } from '../../utils/logger';
import { parseJobDescription, JobDescriptionRecord } from '../../jobs/jobDescriptionFile';

const logger = new Logger('JobRoutes');
const router = express.Router();

const JOBS_DIR = path.resolve(process.cwd(), 'data', 'job_descriptions');
const BANKS_DIR = path.resolve(process.cwd(), 'data', 'question_banks');

/**
 * Question banks are paired with job descriptions by filename:
 * data_scientist.md <-> data_scientist_questions.json
 */
function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function readJob(file: string): JobDescriptionRecord {
  return parseJobDescription(fs.readFileSync(path.join(JOBS_DIR, file), 'utf-8'), file);
}

function listJobFiles(): string[] {
  if (!fs.existsSync(JOBS_DIR)) return [];
  return fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith('.md')).sort();
}

function bankPathFor(jobFile: string): string {
  const base = path.basename(jobFile, '.md');
  return path.join(BANKS_DIR, `${base}_questions.json`);
}

export function loadJobSummaries() {
  return listJobFiles().map((file) => {
    const job = readJob(file);
    const bankFile = bankPathFor(file);
    const questionCount = fs.existsSync(bankFile)
      ? readJson<any>(bankFile).questions?.length || 0
      : 0;

    return {
      id: job.id,
      file,
      title: job.title,
      department: job.department,
      experience_level: job.experience_level,
      years_experience: job.years_experience,
      description: job.description,
      skills: job.skills || [],
      responsibilities: job.responsibilities || [],
      question_count: questionCount,
    };
  });
}

/**
 * One job by ID, with skills and their importance
 */
export function getJobSummary(jobId: string) {
  return loadJobSummaries().find((j) => j.id === jobId) || null;
}

/**
 * Job context text passed to the scoring prompt
 */
export function getJobContext(jobId: string): string {
  const job = loadJobSummaries().find((j) => j.id === jobId);
  if (!job) return '';

  const skills = job.skills.map((s: any) => s.name).join(', ');
  return [
    `Title: ${job.title}`,
    `Level: ${job.experience_level}`,
    job.description,
    skills ? `Required skills: ${skills}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Returns the question bank for a job id, optionally filtered by interview mode
 */
export function loadQuestionsForJob(jobId: string, mode?: string) {
  const jobFile = listJobFiles().find(
    (file) => readJob(file).id === jobId
  );
  if (!jobFile) return null;

  const bankFile = bankPathFor(jobFile);
  if (!fs.existsSync(bankFile)) return [];

  const questions: any[] = readJson<any>(bankFile).questions || [];
  return mode
    ? questions.filter((q) => Array.isArray(q.mode) && q.mode.includes(mode))
    : questions;
}

/**
 * GET /api/v1/jobs
 * List available job descriptions
 */
router.get('/', (req: Request, res: Response) => {
  try {
    res.json({ jobs: loadJobSummaries() });
  } catch (error) {
    logger.error('Error listing jobs', { error });
    res.status(500).json({ error: 'Failed to list jobs' });
  }
});

/**
 * GET /api/v1/jobs/:jobId/questions?mode=A
 * Question bank for a job
 */
router.get('/:jobId/questions', (req: Request, res: Response) => {
  try {
    const mode = typeof req.query.mode === 'string' ? req.query.mode : undefined;
    const questions = loadQuestionsForJob(req.params.jobId, mode);

    if (questions === null) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json({ job_id: req.params.jobId, mode: mode || 'all', questions });
  } catch (error) {
    logger.error('Error loading questions', { error });
    res.status(500).json({ error: 'Failed to load questions' });
  }
});

export default router;
