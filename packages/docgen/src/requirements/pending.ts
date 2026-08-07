import type { FeatureCard } from '../infer/types.js';
import type { Answer, SurfaceAnswers } from '../questions/store.js';
import { compareStrings } from '../util/sort.js';
import type { SurfaceRequirements } from './types.js';

/**
 * Answers that have not yet been classified.
 *
 * Triage sits between "somebody told us what happens" and "we decided what that
 * means". Only answered questions appear here: triaging an unanswered one would
 * be asking a developer to rule on a guess.
 */

export interface PendingItem {
  readonly surfaceId: string;
  readonly slug: string;
  readonly surfaceTitle: string;
  readonly answer: Answer;
}

export function buildPending(args: {
  cards: readonly FeatureCard[];
  answers: ReadonlyMap<string, SurfaceAnswers>;
  requirements: ReadonlyMap<string, SurfaceRequirements>;
}): readonly PendingItem[] {
  const pending: PendingItem[] = [];
  const titles = new Map(args.cards.map((card) => [card.surfaceId, card.title]));
  const slugs = new Map(args.cards.map((card) => [card.surfaceId, card.slug]));

  for (const surface of args.answers.values()) {
    const triaged = new Set(
      (args.requirements.get(surface.surfaceId)?.requirements ?? []).map((r) => r.questionId),
    );

    for (const answer of surface.answers) {
      if (triaged.has(answer.questionId)) continue;
      pending.push({
        surfaceId: surface.surfaceId,
        slug: slugs.get(surface.surfaceId) ?? surface.slug,
        surfaceTitle: titles.get(surface.surfaceId) ?? surface.slug,
        answer,
      });
    }
  }

  return pending.sort(
    (a, b) => compareStrings(a.slug, b.slug) || compareStrings(a.answer.questionId, b.answer.questionId),
  );
}
