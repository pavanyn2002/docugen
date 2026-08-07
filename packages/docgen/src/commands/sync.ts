import fs from 'node:fs/promises';
import path from 'node:path';
import { colors } from '../util/colors.js';
import { loadConfig } from '../config/load.js';
import { runExtraction } from '../pipeline.js';
import { computeExpectedFiles, findDrift } from '../verify/expected.js';
import { ensureGitattributes } from '../render/index.js';
import { compareStrings } from '../util/sort.js';
import { toPosix } from '../util/paths.js';
import type { Logger } from '../util/logger.js';

export interface SyncCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  /** Report what would change without writing. */
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly logger: Logger;
}

/**
 * `docgen sync` — bring the generated files up to date, without calling a model.
 *
 * This is the command that runs after every change. It re-renders everything
 * from the current code and the committed cards and answers, writes only the
 * files whose bytes actually differ, and deletes pages for things that no
 * longer exist.
 *
 * It deliberately does not re-infer. Inference costs money and belongs to
 * `docgen bootstrap`, which is cached per surface — so the normal loop is
 * `sync` on every commit and `bootstrap` only when behaviour genuinely changed.
 * Making the routine command the expensive one is how a tool gets removed from
 * CI.
 */
export async function runSyncCommand(options: SyncCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });

  const run = await runExtraction({ config, logger: options.logger });
  const outDir = toPosix(config.outDir);
  const expected = await computeExpectedFiles(run);
  const drift = await findDrift(config.root, outDir, expected);

  const toWrite = expected.filter((file) =>
    drift.some((item) => item.file === file.path && item.kind !== 'orphaned'),
  );
  const toDelete = drift.filter((item) => item.kind === 'orphaned').map((item) => item.file);

  if (options.dryRun !== true) {
    for (const file of toWrite) {
      const absolute = path.join(config.root, file.path);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, file.contents.replace(/\r\n/g, '\n'), 'utf8');
    }
    for (const file of toDelete) {
      await fs.rm(path.join(config.root, file), { force: true });
    }
    if (config.gitattributes) await ensureGitattributes(config.root, config.outDir);
  }

  if (options.json === true) {
    options.logger.output(
      JSON.stringify(
        {
          dryRun: options.dryRun === true,
          written: toWrite.map((file) => file.path).sort(compareStrings),
          deleted: [...toDelete].sort(compareStrings),
          unchanged: expected.length - toWrite.length,
        },
        null,
        2,
      ),
    );
    return;
  }

  options.logger.heading(options.dryRun === true ? 'docgen sync (dry run)' : 'docgen sync');
  options.logger.info(`  unchanged ${expected.length - toWrite.length}`);
  options.logger.info(`  ${options.dryRun === true ? 'would write' : 'written'}   ${toWrite.length}`);
  options.logger.info(`  ${options.dryRun === true ? 'would delete' : 'deleted'}  ${toDelete.length}`);

  for (const file of toWrite.slice(0, 20)) {
    options.logger.info(`    ${colors().dim('write ')} ${file.path}`);
  }
  if (toWrite.length > 20) {
    options.logger.info(`    ${colors().dim(`… and ${toWrite.length - 20} more`)}`);
  }
  for (const file of toDelete.slice(0, 20)) {
    options.logger.info(`    ${colors().dim('delete')} ${file}`);
  }

  if (toWrite.length === 0 && toDelete.length === 0) {
    options.logger.info(`\n  ${colors().green('already up to date')}`);
  } else if (options.dryRun !== true) {
    options.logger.info(
      `\n  ${colors().dim(
        'Behaviour was re-rendered from the committed cards, not re-inferred. Run ' +
          '`docgen bootstrap` if the behaviour itself changed.',
      )}`,
    );
  }
}
