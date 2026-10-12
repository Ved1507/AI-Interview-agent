/**
 * Interview flow: decides which question comes next.
 * A follow-up is a question instance placed directly after its parent question.
 * Everything here is a pure function over the session, so the rules are easy to test.
 */

import { getConfig } from '../config/env';
import { InterviewSession, QuestionInstance } from '../types/interview.types';

export function isFollowUp(question: QuestionInstance): boolean {
  return question.generated_by_mode === 'follow_up';
}

/** Questions asked on the interview's main track (not follow-ups) */
export function mainQuestions(session: InterviewSession): QuestionInstance[] {
  return session.questions.filter((q) => !isFollowUp(q));
}

export function followUpsFor(session: InterviewSession, parentId: string): QuestionInstance[] {
  return session.questions.filter((q) => q.parent_question_id === parentId);
}

export function isAnswered(session: InterviewSession, question: QuestionInstance): boolean {
  if (isFollowUp(question)) {
    const parent = session.responses.find((r) => r.question_instance_id === question.parent_question_id);
    return !!parent?.follow_ups?.some((f) => f.question_instance_id === question.id);
  }
  return session.responses.some((r) => r.question_instance_id === question.id);
}

/** The next unanswered item. Questions are stored in asking order, so a follow-up comes before the next main question. */
export function nextItem(session: InterviewSession): QuestionInstance | null {
  return session.questions.find((q) => !isAnswered(session, q)) || null;
}

/**
 * Plan a follow-up after a main question. Returns the new question and the full updated list.
 * Enforces MAX_FOLLOW_UPS_PER_QUESTION per main question.
 */
export function planFollowUp(
  session: InterviewSession,
  parentId: string,
  text: string,
  trigger: 'vague' | 'incomplete' | 'contradicting'
): { instance: QuestionInstance; questions: QuestionInstance[] } {
  const parent = session.questions.find((q) => q.id === parentId);
  if (!parent || isFollowUp(parent)) {
    throw new Error('A follow-up must attach to a main question');
  }

  const max = getConfig().maxFollowUpsPerQuestion;
  const existing = followUpsFor(session, parentId);
  if (existing.length >= max) {
    throw new Error(`Follow-up limit reached for this question (${max})`);
  }

  const instance: QuestionInstance = {
    id: `fu_${parentId}_${existing.length + 1}`,
    question_id: parent.question_id,
    text,
    order: parent.order,
    skill_area: parent.skill_area,
    difficulty: parent.difficulty,
    generated_by_mode: 'follow_up',
    parent_question_id: parentId,
    trigger,
    timestamp: new Date().toISOString(),
  };

  // Insert after the parent, or after its last existing follow-up
  const anchorId = existing.length ? existing[existing.length - 1].id : parentId;
  const index = session.questions.findIndex((q) => q.id === anchorId);
  const questions = [...session.questions];
  questions.splice(index + 1, 0, instance);

  return { instance, questions };
}
