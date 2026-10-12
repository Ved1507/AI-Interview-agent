/**
 * Report Routes
 * Generate the cumulative interview report and export it as JSON, Markdown or PDF
 */

import { Router, Request, Response } from 'express';
import { ReportService } from '../../reporting/ReportService';
import { renderMarkdown } from '../../reporting/markdownExporter';
import { renderPdf } from '../../reporting/pdfExporter';
import { Logger } from '../../utils/logger';

const router = Router();
const logger = new Logger('ReportRoutes');

function errorStatus(message: string): number {
  if (message.includes('not found')) return 404;
  if (message.includes('has not completed') || message.includes('No answers')) return 409;
  return 502;
}

/**
 * POST /api/v1/reports/:sessionId/generate
 * Build the report from answers, CV, job description and scores
 */
router.post('/:sessionId/generate', async (req: Request, res: Response) => {
  try {
    const report = await ReportService.generate(req.params.sessionId);
    res.status(201).json({
      report_id: report.id,
      session_id: report.interview_session_id,
      recommendation: report.executive_summary.recommendation,
      overall_score: report.executive_summary.overall_score,
      evidence_sufficient: report.executive_summary.evidence_sufficient,
      generated_at: report.generated_at,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Report generation failed', { sessionId: req.params.sessionId, error: message });
    res.status(errorStatus(message)).json({ error: message });
  }
});

/**
 * GET /api/v1/reports/:sessionId/json
 */
router.get('/:sessionId/json', async (req: Request, res: Response) => {
  try {
    const report = await ReportService.get(req.params.sessionId);
    if (!report) {
      return res.status(404).json({ error: 'No report yet. Generate one first.' });
    }
    res.json(report);
  } catch (error) {
    logger.error('Error reading report', { error });
    res.status(500).json({ error: 'Failed to read report' });
  }
});

/**
 * GET /api/v1/reports/:sessionId/markdown
 */
router.get('/:sessionId/markdown', async (req: Request, res: Response) => {
  try {
    const report = await ReportService.get(req.params.sessionId);
    if (!report) {
      return res.status(404).json({ error: 'No report yet. Generate one first.' });
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report-${report.interview_session_id}.md"`);
    res.send(renderMarkdown(report));
  } catch (error) {
    logger.error('Error rendering markdown report', { error });
    res.status(500).json({ error: 'Failed to render report' });
  }
});

/**
 * GET /api/v1/reports/:sessionId/pdf
 */
router.get('/:sessionId/pdf', async (req: Request, res: Response) => {
  try {
    const report = await ReportService.get(req.params.sessionId);
    if (!report) {
      return res.status(404).json({ error: 'No report yet. Generate one first.' });
    }
    const pdf = await renderPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="report-${report.interview_session_id}.pdf"`);
    res.send(pdf);
  } catch (error) {
    logger.error('Error rendering PDF report', { error });
    res.status(500).json({ error: 'Failed to render PDF' });
  }
});

export default router;
