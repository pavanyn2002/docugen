import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { colors } from '../util/colors.js';
import { loadConfig } from '../config/load.js';
import { installAdapters } from '../adapters/install.js';
import { ENGINE_VERSION } from '../util/version.js';
import type { Logger } from '../util/logger.js';

const execFileAsync = promisify(execFile);

export interface InitCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  /** Install every adapter, not only the ones this repo shows evidence of. */
  readonly all?: boolean;
  readonly hooks?: boolean;
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
  const defaultBranch = await resolveDefaultBranch(config.root);
  const outcomes = await installAdapters({
    root: config.root,
    invocation,
    defaultBranch,
    version: ENGINE_VERSION,
    ...(options.all === undefined ? {} : { all: options.all }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });

  options.logger.info(`  invocation  ${invocation}`);
  options.logger.info(`  branch      ${defaultBranch}\n`);

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
      'Shared instruction files preserve everything outside docgen markers. ' +
        'Docgen-owned adapter files are deterministic and MCP JSON is merged by key.',
    )}`,
  );

  options.logger.heading('Next');
  options.logger.info('  1. `docgen session start` - evidence, plans, and questions');
  options.logger.info('  2. `docgen bootstrap`     - optional behaviour inference; costs money');
  options.logger.info('  3. `docgen session end`   - docs, tester handoff, and gate');
}

/**
 * The repo's default branch, for the CI workflow's triggers.
 *
 * Read from the remote's HEAD rather than assumed, because a workflow that
 * triggers on a branch this repo does not have never runs, and a gate that
 * never runs is indistinguishable from a gate that always passes.
 */
export async function resolveDefaultBranch(root: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: root,
      timeout: 5_000,
      windowsHide: true,
    });
    const branch = stdout.trim().replace(/^origin\//, '');
    if (branch.length > 0) return branch;
  } catch {
    // No remote, or no HEAD recorded for it.
  }

  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: root,
      timeout: 5_000,
      windowsHide: true,
    });
    const branch = stdout.trim();
    if (branch.length > 0) return branch;
  } catch {
    // Not a git checkout.
  }

  return 'main';
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
