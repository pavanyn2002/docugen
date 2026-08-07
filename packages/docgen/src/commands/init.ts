import fs from 'node:fs/promises';
import path from 'node:path';
import { colors } from '../util/colors.js';
import { loadConfig } from '../config/load.js';
import { installAdapters } from '../adapters/install.js';
import type { Logger } from '../util/logger.js';

export interface InitCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  /** Install every adapter, not only the ones this repo shows evidence of. */
  readonly all?: boolean;
  readonly logger: Logger;
}

/**
 * `docgen init` — make the question queue reachable from the developer's tools.
 *
 * Without this, `docgen ask` is a command nobody remembers to run, and the
 * questions sit unanswered forever. With it, the agent already open in the
 * repository knows to raise them at the point work finishes — which is the only
 * moment a developer has both the context and the willingness to answer.
 */
export async function runInitCommand(options: InitCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });

  options.logger.heading('docgen init');

  const invocation = await resolveInvocation(config.root);
  const outcomes = await installAdapters({
    root: config.root,
    invocation,
    ...(options.all === undefined ? {} : { all: options.all }),
  });

  options.logger.info(`  invocation  ${invocation}\n`);

  for (const outcome of outcomes) {
    const label =
      outcome.action === 'unchanged'
        ? colors().dim('unchanged')
        : outcome.action === 'created'
          ? colors().green('created  ')
          : colors().green('updated  ');
    options.logger.info(`  ${label} ${outcome.file}`);
  }

  options.logger.info(
    `\n  ${colors().dim(
      'Only the block between the docgen markers is managed. Anything you write outside ' +
        'those markers is preserved.',
    )}`,
  );

  options.logger.heading('Next');
  options.logger.info('  1. `docgen extract`   — structure, free, no model');
  options.logger.info('  2. `docgen bootstrap` — behaviour, uses your coding CLI, costs money');
  options.logger.info('  3. `docgen ask`       — the questions that turn inferred into verified');
}

/**
 * How this repo should invoke docgen.
 *
 * A local dependency is invoked through the package manager so it resolves to
 * the pinned version; otherwise the bare command is assumed to be on PATH.
 * Guessing wrong here means every instruction file tells the agent to run a
 * command that does not exist.
 */
export async function resolveInvocation(root: string): Promise<string> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared =
      manifest.dependencies?.['@tatvaops/docgen'] ?? manifest.devDependencies?.['@tatvaops/docgen'];
    if (declared !== undefined) return 'npx docgen';
  } catch {
    // No manifest, or unreadable — fall through to the bare command.
  }
  return 'docgen';
}
