/**
 * Markdown exporter for the interview report
 */

import { FeedbackReport } from './ReportService';

const LEVEL = {
  strong_hire: 'Strong hire',
  hire: 'Hire',
  hold: 'Hold',
  no_hire: 'No hire',
} as const;

const DIMENSION = {
  technical_skills: 'Technical skills',
  domain_understanding: 'Domain understanding',
  problem_solving: 'Problem solving',
  communication: 'Communication',
} as const;

/** Escape characters that would break a Markdown table cell */
function cell(text: string): string {
  return String(text || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function bullets(items: string[]): string {
  return items.length ? items.map((i) => `- ${i}`).join('\n') : '- None recorded';
}

export function renderMarkdown(r: FeedbackReport): string {
  const es = r.executive_summary;
  const lines: string[] = [];

  lines.push(`# Interview Report`);
  lines.push('');
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Candidate | ${cell(r.candidate_id)} |`);
  lines.push(`| Job | ${cell(r.job_id)} |`);
  lines.push(`| Interview mode | ${r.methodology.interview_mode} (${r.methodology.total_questions} questions) |`);
  lines.push(`| Session | ${r.interview_session_id} |`);
  lines.push(`| Generated | ${r.generated_at} |`);
  lines.push(`| Approval status | ${r.approval_status.replace(/_/g, ' ')} |`);
  lines.push('');

  lines.push('## Executive summary');
  lines.push('');
  lines.push(`**AI recommendation:** ${LEVEL[es.recommendation]} (confidence: ${es.confidence})`);
  if (es.final_recommendation && es.final_recommendation !== es.recommendation) {
    lines.push('');
    lines.push(`**Final decision (human review):** ${LEVEL[es.final_recommendation]}`);
  } else if (es.final_recommendation) {
    lines.push('');
    lines.push(`**Final decision (human review):** ${LEVEL[es.final_recommendation]} (AI recommendation accepted)`);
  }
  lines.push('');
  lines.push(`**Weighted score:** ${es.overall_score}/100`);
  lines.push('');
  lines.push(es.summary);
  lines.push('');
  lines.push(`**Evidence sufficient:** ${es.evidence_sufficient ? 'yes' : 'no. Treat the scores with caution.'}`);
  lines.push('');
  lines.push('### Key strengths');
  lines.push(bullets(es.key_strengths));
  lines.push('');
  lines.push('### Key gaps');
  lines.push(bullets(es.key_gaps));
  lines.push('');
  lines.push('### Next steps');
  lines.push(es.next_steps || 'None recorded');
  lines.push('');

  lines.push('## Integrity notes');
  lines.push(bullets(r.integrity_notes));
  lines.push('');

  lines.push('## Dimension scores');
  lines.push('');
  lines.push('| Dimension | Score | Confidence |');
  lines.push('|---|---|---|');
  Object.entries(r.dimension_scores).forEach(([key, d]) => {
    lines.push(`| ${DIMENSION[key as keyof typeof DIMENSION] || key} | ${d.score}/100 | ${Math.round(d.confidence * 100)}% |`);
  });
  lines.push('');
  Object.entries(r.dimension_scores).forEach(([key, d]) => {
    lines.push(`### ${DIMENSION[key as keyof typeof DIMENSION] || key}`);
    lines.push(d.description || '');
    d.evidence.forEach((e) => lines.push(`> ${e.quote}`));
    lines.push('');
  });

  lines.push('## Question-by-question feedback');
  lines.push('');
  r.detailed_feedback.questions.forEach((q) => {
    lines.push(`### Q${q.question_number}. ${q.question_text}`);
    lines.push(`- Answer quality: **${q.answer_quality}** (${q.word_count} words)`);
    lines.push(`- Assessment: ${q.assessment}`);
    if (q.evidence_quote) lines.push(`- Evidence: "${q.evidence_quote}"`);
    lines.push('');
  });

  lines.push('## CV alignment');
  lines.push('');
  lines.push(r.cv_alignment.summary || 'No summary');
  lines.push('');
  if (r.cv_alignment.claims.length) {
    lines.push('| CV claim | Status | Evidence |');
    lines.push('|---|---|---|');
    r.cv_alignment.claims.forEach((c) => lines.push(`| ${cell(c.claim)} | ${c.status.replace(/_/g, ' ')} | ${cell(c.evidence)} |`));
    lines.push('');
  }

  lines.push('## Job fit');
  lines.push('');
  lines.push(r.job_fit.summary || 'No summary');
  lines.push('');
  if (r.job_fit.requirements.length) {
    lines.push('| Requirement | Status | Note |');
    lines.push('|---|---|---|');
    r.job_fit.requirements.forEach((q) => lines.push(`| ${cell(q.requirement)} | ${q.status.replace(/_/g, ' ')} | ${cell(q.note)} |`));
    lines.push('');
  }

  lines.push('## Method and security');
  lines.push('');
  lines.push(`- Question source: ${r.methodology.question_source}`);
  lines.push(`- Scoring model: ${r.methodology.scoring_model} (rubric ${r.methodology.rubric_version})`);
  lines.push(`- Interview duration: ${r.methodology.interview_duration_minutes} minutes`);
  lines.push(`- Injection attempts found: ${r.security_notes.injection_attempts_found ? 'yes' : 'no'}`);
  lines.push(`- Note: ${r.security_notes.impact_on_scoring}`);
  lines.push('');

  if (r.reviewer_notes) {
    lines.push('## Reviewer notes');
    lines.push('');
    lines.push(r.reviewer_notes);
    lines.push('');
  }

  lines.push('## Transcript');
  lines.push('');
  lines.push('```text');
  lines.push(r.full_transcript.transcript_text);
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}
