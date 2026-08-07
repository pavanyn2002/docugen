import { colors } from '../util/colors.js';
import { loadConfig } from '../config/load.js';
import { syncGenerated } from '../verify/write.js';
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

  const report = await syncGenerated({
    config,
    logger: options.logger,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });

  if (options.json === true) {
    options.logger.output(
      JSON.stringify({ dryRun: options.dryRun === true, ...report }, null, 2),
    );
    return;
  }

  const dry = options.dryRun === true;
  options.logger.heading(dry ? 'docgen sync (dry run)' : 'docgen sync');
  options.logger.info(`  unchanged ${report.unchanged}`);
  options.logger.info(`  ${dry ? 'would write' : 'written'}   ${report.written.length}`);
  options.logger.info(`  ${dry ? 'would delete' : 'deleted'}  ${report.deleted.length}`);

  for (const file of report.written.slice(0, 20)) {
    options.logger.info(`    ${colors().dim('write ')} ${file}`);
  }
  if (report.written.length > 20) {
    options.logger.info(`    ${colors().dim(`… and ${report.written.length - 20} more`)}`);
  }
  for (const file of report.deleted.slice(0, 20)) {
    options.logger.info(`    ${colors().dim('delete')} ${file}`);
  }

  if (report.written.length === 0 && report.deleted.length === 0) {
    options.logger.info(`\n  ${colors().green('already up to date')}`);
  } else if (!dry) {
    options.logger.info(
      `\n  ${colors().dim(
        'Behaviour was re-rendered from the committed cards, not re-inferred. Run ' +
          '`docgen bootstrap` if the behaviour itself changed.',
      )}`,
    );
  }
}
