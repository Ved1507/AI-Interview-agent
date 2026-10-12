/**
 * PDF exporter for the interview report (pdfkit, in-memory)
 */

import PDFDocument from 'pdfkit';
import { FeedbackReport } from './ReportService';

const LEVEL = {
  strong_hire: 'Strong hire',
  hire: 'Hire',
  hold: 'Hold',
  no_hire: 'No hire',
} as const;

export function renderPdf(r: FeedbackReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const heading = (text: string) => {
      doc.moveDown(0.8).font('Helvetica-Bold').fontSize(13).fillColor('#1c2330').text(text);
      doc.moveDown(0.3).font('Helvetica').fontSize(10).fillColor('#1c2330');
    };
    const para = (text: string) => doc.text(text || '—', { align: 'left' });
    const bullets = (items: string[]) => {
      if (!items.length) return para('None recorded');
      items.forEach((i) => doc.text(`•  ${i}`, { indent: 8 }));
    };

    const es = r.executive_summary;

    doc.font('Helvetica-Bold').fontSize(18).fillColor('#1c2330').text('Interview Report');
    doc.font('Helvetica').fontSize(10).fillColor('#5d6777');
    doc.text(`Candidate: ${r.candidate_id}    Job: ${r.job_id}    Mode: ${r.methodology.interview_mode}`);
    doc.text(`Session: ${r.interview_session_id}`);
    doc.text(`Generated: ${r.generated_at}    Approval: ${r.approval_status.replace(/_/g, ' ')}`);
    doc.fillColor('#1c2330');

    heading('Executive summary');
    para(`AI recommendation: ${LEVEL[es.recommendation]} (confidence ${es.confidence})`);
    if (es.final_recommendation) para(`Final decision (human review): ${LEVEL[es.final_recommendation]}`);
    para(`Weighted score: ${es.overall_score}/100`);
    doc.moveDown(0.3);
    para(es.summary);
    para(`Evidence sufficient: ${es.evidence_sufficient ? 'yes' : 'no. Treat the scores with caution.'}`);

    doc.moveDown(0.4).font('Helvetica-Bold').text('Key strengths');
    doc.font('Helvetica'); bullets(es.key_strengths);
    doc.moveDown(0.3).font('Helvetica-Bold').text('Key gaps');
    doc.font('Helvetica'); bullets(es.key_gaps);
    doc.moveDown(0.3).font('Helvetica-Bold').text('Next steps');
    doc.font('Helvetica'); para(es.next_steps);

    heading('Integrity notes');
    bullets(r.integrity_notes);

    heading('Dimension scores');
    Object.entries(r.dimension_scores).forEach(([key, d]) => {
      doc.font('Helvetica-Bold').text(`${key.replace(/_/g, ' ')}: ${d.score}/100 (confidence ${Math.round(d.confidence * 100)}%)`);
      doc.font('Helvetica').text(d.description || '');
      d.evidence.forEach((e) => doc.font('Helvetica-Oblique').text(`"${e.quote}"`, { indent: 8 }));
      doc.font('Helvetica').moveDown(0.3);
    });

    heading('Question-by-question feedback');
    r.detailed_feedback.questions.forEach((q) => {
      doc.font('Helvetica-Bold').text(`Q${q.question_number}. ${q.question_text}`);
      doc.font('Helvetica').text(`Answer quality: ${q.answer_quality} (${q.word_count} words)`);
      doc.text(q.assessment);
      if (q.evidence_quote) doc.font('Helvetica-Oblique').text(`"${q.evidence_quote}"`, { indent: 8 }).font('Helvetica');
      doc.moveDown(0.4);
    });

    heading('CV alignment');
    para(r.cv_alignment.summary);
    r.cv_alignment.claims.forEach((c) => doc.text(`•  ${c.claim} — ${c.status.replace(/_/g, ' ')}${c.evidence ? `: ${c.evidence}` : ''}`, { indent: 8 }));

    heading('Job fit');
    para(r.job_fit.summary);
    r.job_fit.requirements.forEach((q) => doc.text(`•  ${q.requirement} — ${q.status.replace(/_/g, ' ')}${q.note ? `: ${q.note}` : ''}`, { indent: 8 }));

    heading('Method and security');
    doc.text(`Question source: ${r.methodology.question_source}`);
    doc.text(`Scoring model: ${r.methodology.scoring_model} (rubric ${r.methodology.rubric_version})`);
    doc.text(`Interview duration: ${r.methodology.interview_duration_minutes} minutes`);
    doc.text(`Injection attempts found: ${r.security_notes.injection_attempts_found ? 'yes' : 'no'}`);
    doc.text(r.security_notes.impact_on_scoring);

    if (r.reviewer_notes) {
      heading('Reviewer notes');
      para(r.reviewer_notes);
    }

    heading('Transcript');
    doc.font('Courier').fontSize(8).text(r.full_transcript.transcript_text);

    doc.end();
  });
}
