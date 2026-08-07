import fs from 'node:fs/promises';
import path from 'node:path';
import type { GenerationContext } from '../types/core.js';
import { compareStrings } from '../util/sort.js';
import type { SurfaceAnswers } from '../questions/store.js';
import { BEHAVIOUR_DIR, renderBehaviourIndex, renderBehaviourPage } from './behaviour.js';
import type { FeatureCard } from './types.js';

export interface WriteBehaviourArgs {
  readonly root: string;
  /** Output directory, repo-relative POSIX, e.g. 'docs/generated'. */
  readonly outDir: string;
  readonly cards: readonly FeatureCard[];
  readonly answers: ReadonlyMap<string, SurfaceAnswers>;
  readonly context: GenerationContext;
}

/**
 * Write the behaviour pages.
 *
 * Kept out of `render/writeAll` on purpose: that path is the static lane and
 * must stay free of anything a model produced, so `docgen extract` never emits
 * an unverified page. These are written by the commands that own inferred
 * content instead.
 *
 * Stale pages are removed. A surface that no longer exists, or one whose card
 * failed to regenerate, must not leave a page behind describing code that is
 * gone — that is worse than having no page at all.
 */
export async function writeBehaviourPages(args: WriteBehaviourArgs): Promise<readonly string[]> {
  const directory = path.join(args.root, args.outDir, BEHAVIOUR_DIR);
  await fs.mkdir(directory, { recursive: true });

  const written: string[] = [];
  const expected = new Set<string>();

  for (const card of args.cards) {
    const relative = `${args.outDir}/${BEHAVIOUR_DIR}/${card.slug}.md`;
    expected.add(`${card.slug}.md`);
    await fs.writeFile(
      path.join(args.root, relative),
      normalise(
        renderBehaviourPage({
          card,
          answers: args.answers.get(card.surfaceId),
          context: args.context,
          outDir: args.outDir,
        }),
      ),
      'utf8',
    );
    written.push(relative);
  }

  const indexPath = `${args.outDir}/${BEHAVIOUR_DIR}.md`;
  await fs.writeFile(
    path.join(args.root, indexPath),
    normalise(
      renderBehaviourIndex({
        cards: args.cards,
        answers: args.answers,
        context: args.context,
        outDir: args.outDir,
      }),
    ),
    'utf8',
  );
  written.push(indexPath);

  await removeStalePages(directory, expected);

  return written.sort(compareStrings);
}

/** Delete generated pages that no longer correspond to a card. */
async function removeStalePages(directory: string, expected: ReadonlySet<string>): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md') || expected.has(entry)) continue;
    await fs.rm(path.join(directory, entry), { force: true });
  }
}

/** LF everywhere, so the same repo renders byte-identically on any machine. */
function normalise(contents: string): string {
  return contents.replace(/\r\n/g, '\n');
}
