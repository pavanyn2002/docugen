import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FeatureCard, Unknown } from '../infer/types.js';
import type { SurfaceAnswers } from './store.js';
import { compareStrings } from '../util/sort.js';

const execFileAsync = promisify(execFile);

/**
 * The open question queue.
 *
 * Every unknown a model recorded, minus the ones already answered, routed to
 * whoever last touched the code it concerns. Routing is a filter, not an
 * assignment: `docgen ask` shows a developer their own questions first because
 * a queue of 200 questions with no ordering gets ignored, but anyone can answer
 * anything.
 */

export interface Question {
  readonly surfaceId: string;
  readonly slug: string;
  readonly surfaceTitle: string;
  readonly unknown: Unknown;
  /** Email of the last author of the surface's primary file, when known. */
  readonly likelyOwner?: string;
  /** File used to attribute the question. */
  readonly attributedTo?: string;
}

export interface QuestionQueue {
  readonly questions: readonly Question[];
  /** Distinct owners, for the summary line. */
  readonly owners: readonly string[];
}

export function buildQueue(args: {
  cards: readonly FeatureCard[];
  answers: ReadonlyMap<string, SurfaceAnswers>;
  ownersBySurface?: ReadonlyMap<string, { email: string; file: string }>;
}): QuestionQueue {
  const questions: Question[] = [];

  for (const card of args.cards) {
    const answered = new Set((args.answers.get(card.surfaceId)?.answers ?? []).map((a) => a.questionId));
    const owner = args.ownersBySurface?.get(card.surfaceId);

    for (const unknown of card.body.unknowns) {
      if (answered.has(unknown.id)) continue;
      questions.push({
        surfaceId: card.surfaceId,
        slug: card.slug,
        surfaceTitle: card.title,
        unknown,
        ...(owner === undefined ? {} : { likelyOwner: owner.email, attributedTo: owner.file }),
      });
    }
  }

  questions.sort(
    (a, b) => compareStrings(a.slug, b.slug) || compareStrings(a.unknown.id, b.unknown.id),
  );

  return {
    questions,
    owners: [...new Set(questions.map((q) => q.likelyOwner).filter((e): e is string => e !== undefined))].sort(
      compareStrings,
    ),
  };
}

/**
 * Who last touched a file, by email.
 *
 * Deliberately the *last* author rather than the majority author: the person
 * who most recently changed a file is the one most likely to remember why it
 * behaves as it does. Returns undefined outside a git checkout, or for a file
 * with no history — routing is a convenience, and its absence must never stop
 * the queue being usable.
 */
export async function lastAuthorOf(root: string, file: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '-1', '--format=%ae', '--', file],
      { cwd: root, timeout: 10_000, windowsHide: true },
    );
    const email = stdout.trim();
    return email.length > 0 ? email : undefined;
  } catch {
    return undefined;
  }
}

/** The current user's git email, so `--mine` can filter. */
export async function currentGitEmail(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['config', 'user.email'], {
      cwd: root,
      timeout: 5_000,
      windowsHide: true,
    });
    const email = stdout.trim();
    return email.length > 0 ? email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Attribute each card to a likely owner.
 *
 * One `git log` per surface, over its first source file. Blaming every file of
 * every surface would multiply the cost for a routing hint that only needs to
 * be roughly right.
 */
export async function resolveOwners(args: {
  root: string;
  cards: readonly FeatureCard[];
  filesBySurface: ReadonlyMap<string, readonly string[]>;
}): Promise<ReadonlyMap<string, { email: string; file: string }>> {
  const owners = new Map<string, { email: string; file: string }>();

  for (const card of args.cards) {
    const file = args.filesBySurface.get(card.surfaceId)?.[0];
    if (file === undefined) continue;
    const email = await lastAuthorOf(args.root, file);
    if (email !== undefined) owners.set(card.surfaceId, { email, file });
  }

  return owners;
}
