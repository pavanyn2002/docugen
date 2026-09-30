import type { Answer } from '../questions/store.js';
import type { FeatureCard, Unknown } from './types.js';

/** Explicit human confirmation remains possible even when the model raised no questions. */
export const BEHAVIOR_CONFIRMATION: Unknown = {
  id: 'behavior-confirmation',
  question: 'What behavior has a developer reviewed and confirmed for this surface?',
  why: 'Critical inferred behavior needs an attributed human confirmation before it can pass governance.',
  options: [],
};

export function isAttributedAnswer(answer: Answer): boolean {
  return answer.answer.trim().length > 0 && answer.question.trim().length > 0 &&
    answer.answeredBy.trim().length > 0 && answer.answeredBy !== 'unknown' &&
    !Number.isNaN(Date.parse(answer.answeredAt));
}

export function hasHumanConfirmation(card: FeatureCard, answers: readonly Answer[]): boolean {
  const questionIds = new Set([BEHAVIOR_CONFIRMATION.id, ...card.body.unknowns.map((unknown) => unknown.id)]);
  return answers.some((answer) => questionIds.has(answer.questionId) && isAttributedAnswer(answer));
}
