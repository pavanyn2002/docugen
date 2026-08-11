import fs from 'node:fs/promises';
import path from 'node:path';
import { computeFindings } from '../analysis/findings.js';
import { renderAll } from '../render/index.js';
import type { RenderedFile } from '../render/index.js';
import { BEHAVIOUR_DIR, renderBehaviourIndex, renderBehaviourPage } from '../infer/behaviour.js';
import { loadCards } from '../infer/store.js';
import { loadAnswers } from '../questions/store.js';
import { loadRequirements } from '../requirements/store.js';
import { buildPending } from '../requirements/pending.js';
import { renderRequirementsPage } from '../requirements/render.js';
import { scanTestReferences } from '../trace/scan.js';
import { buildMatrix } from '../trace/matrix.js';
import { renderTestCasesPage, renderTraceabilityPage } from '../trace/render.js';
import type { RunResult } from '../pipeline.js';
import { compareStrings } from '../util/sort.js';
import { toPosix } from '../util/paths.js';
import { computeGovernanceFiles } from '../governance/expected.js';

/**
 * Every file docgen would write, given the current code and the current stores.
 *
 * Computed without calling a model. That is the property that makes a CI gate
 * possible at all: `check` has to be able to say "the docs are stale" on every
 * pull request, and it cannot do that if saying so costs money or depends on a
 * model returning the same words twice.
 *
 * Inference results are read from `docs/.cards/` rather than regenerated, so a
 * surface whose card is missing simply has no page — `check` reports drift in
 * what exists, never invents what has not been inferred.
 */
export async function computeExpectedFiles(run: RunResult): Promise<readonly RenderedFile[]> {
  const root = run.config.root;
  const outDir = toPosix(run.config.outDir);

  const cards = [...(await loadCards(root)).values()].sort((a, b) => compareStrings(a.slug, b.slug));
  const answers = await loadAnswers(root);
  const requirements = await loadRequirements(root);

  const findings = await computeFindings(run);
  const files: RenderedFile[] = [
    ...renderAll(run, findings, {
      behaviour: cards.length > 0,
      requirements: requirements.size > 0,
    }),
  ];
  files.push(...(await computeGovernanceFiles(run)));

  for (const card of cards) {
    files.push({
      path: `${outDir}/${BEHAVIOUR_DIR}/${card.slug}.md`,
      contents: renderBehaviourPage({
        card,
        answers: answers.get(card.surfaceId),
        context: run.context,
        outDir,
      }),
    });
  }

  if (cards.length > 0) {
    files.push({
      path: `${outDir}/${BEHAVIOUR_DIR}.md`,
      contents: renderBehaviourIndex({ cards, answers, context: run.context, outDir }),
    });
  }

  if (requirements.size > 0) {
    files.push({
      path: `${outDir}/requirements.md`,
      contents: renderRequirementsPage({
        requirements,
        context: run.context,
        pendingCount: buildPending({ cards, answers, requirements }).length,
      }),
    });

    // Traceability only exists once something has been triaged. Emitting an
    // empty matrix beforehand would read as "nothing is traced" rather than
    // "nothing has been decided yet", which are very different problems.
    const references = await scanTestReferences({
      root,
      globs: run.config.trace.include,
      exclude: run.config.effectiveExclude,
    });
    const matrix = buildMatrix({ requirements, cards, references, answers });

    files.push(
      {
        path: `${outDir}/test-cases.md`,
        contents: renderTestCasesPage({ matrix, context: run.context, outDir }),
      },
      {
        path: `${outDir}/traceability.md`,
        contents: renderTraceabilityPage({ matrix, context: run.context, outDir }),
      },
    );
  }

  return files.sort((a, b) => compareStrings(a.path, b.path));
}

export type DriftKind = 'missing' | 'changed' | 'orphaned';

export interface Drift {
  readonly file: string;
  readonly kind: DriftKind;
}

/**
 * Compare what should be on disk against what is.
 *
 * `orphaned` is reported separately from the rest because it means something
 * different: not that a page is out of date, but that it documents something
 * which no longer exists. Left in place it is worse than a stale page, because
 * nothing about it looks wrong.
 */
export async function findDrift(
  root: string,
  outDir: string,
  expected: readonly RenderedFile[],
): Promise<readonly Drift[]> {
  const drift: Drift[] = [];
  const expectedPaths = new Set(expected.map((file) => file.path));

  for (const file of expected) {
    let actual: string;
    try {
      actual = await fs.readFile(path.join(root, file.path), 'utf8');
    } catch {
      drift.push({ file: file.path, kind: 'missing' });
      continue;
    }
    if (normalise(actual) !== normalise(file.contents)) {
      drift.push({ file: file.path, kind: 'changed' });
    }
  }

  for (const found of await listGenerated(root, toPosix(outDir))) {
    if (!expectedPaths.has(found)) drift.push({ file: found, kind: 'orphaned' });
  }

  return drift.sort((a, b) => compareStrings(a.file, b.file) || compareStrings(a.kind, b.kind));
}

/** Every file under the output directory, repo-relative POSIX. */
async function listGenerated(root: string, outDir: string): Promise<readonly string[]> {
  const found: string[] = [];

  async function walk(relative: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else found.push(next);
    }
  }

  await walk(outDir);
  return found.sort(compareStrings);
}

function normalise(contents: string): string {
  return contents.replace(/\r\n/g, '\n');
}
