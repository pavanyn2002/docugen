import fs from 'node:fs/promises';
import path from 'node:path';
import { runExtraction } from '../pipeline.js';
import { ensureGitattributes } from '../render/index.js';
import { compareStrings } from '../util/sort.js';
import { toPosix } from '../util/paths.js';
import type { ResolvedConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import { computeExpectedFiles, findDrift } from './expected.js';
import { loadFeatureRecords } from '../features/store.js';
import { writeFileAtomically } from '../util/atomic.js';

export interface SyncReport {
  readonly written: readonly string[];
  readonly deleted: readonly string[];
  readonly unchanged: number;
}

/**
 * Write every generated file that is not already correct.
 *
 * Shared by `sync` and by the commands that change what the documentation says
 * — `answer` and `triage`. Those have to leave the repository in a state that
 * passes `docgen check`, because a command that puts the repo in a failing
 * state and does not say so turns the CI gate into noise, and a noisy gate gets
 * disabled.
 *
 * Never calls a model. Inference comes from the committed cards.
 */
export async function syncGenerated(args: {
  config: ResolvedConfig;
  logger: Logger;
  /** Compute what would change without touching the filesystem. */
  dryRun?: boolean;
}): Promise<SyncReport> {
  const { config } = args;
  const outDir = toPosix(config.outDir);

  const run = await runExtraction({
    config,
    logger: args.logger,
    includeSymbols: (await loadFeatureRecords(config.root)).length > 0,
  });
  const expected = await computeExpectedFiles(run);
  const drift = await findDrift(config.root, outDir, expected);

  const toWrite = expected.filter((file) =>
    drift.some((item) => item.file === file.path && item.kind !== 'orphaned'),
  );
  const toDelete = drift.filter((item) => item.kind === 'orphaned').map((item) => item.file);

  if (args.dryRun !== true) {
    for (const file of toWrite) {
      const absolute = path.join(config.root, file.path);
      await writeFileAtomically(absolute, file.contents.replace(/\r\n/g, '\n'));
    }
    for (const file of toDelete) {
      await fs.rm(path.join(config.root, file), { force: true });
    }
    if (config.gitattributes) await ensureGitattributes(config.root, config.outDir);
  }

  return {
    written: toWrite.map((file) => file.path).sort(compareStrings),
    deleted: [...toDelete].sort(compareStrings),
    unchanged: expected.length - toWrite.length,
  };
}
