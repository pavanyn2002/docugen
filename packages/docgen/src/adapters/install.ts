import fs from 'node:fs/promises';
import path from 'node:path';
import { compareStrings } from '../util/sort.js';
import { upsertManagedBlock } from './block.js';
import { renderAgentInstructions, renderCursorRule } from './instructions.js';
import {
  DEPENDABOT_PATH,
  GITHUB_WORKFLOW_PATH,
  renderDependabotConfig,
  renderGithubWorkflow,
} from './ci.js';

/**
 * Install the agent adapters.
 *
 * `AGENTS.md` is written always — it is the one file every current coding agent
 * reads, so it is the closest thing to a neutral target. Tool-specific files are
 * written only where the repository already shows that tool in use: creating a
 * `.cursor/` directory in a repo that has never used Cursor is clutter, and
 * clutter is how a tool gets uninstalled.
 */

export type AdapterId = 'agents' | 'claude' | 'cursor' | 'ci' | 'updates';

export interface AdapterOutcome {
  readonly id: AdapterId;
  readonly file: string;
  readonly action: 'created' | 'updated' | 'unchanged';
}

export interface InstallArgs {
  readonly root: string;
  readonly invocation: string;
  /** Install every adapter, not only the ones this repo shows evidence of. */
  readonly all?: boolean;
  /** Default branch, for the CI workflow's triggers. */
  readonly defaultBranch?: string;
  /** Version to pin in CI when docgen is not a repo dependency. */
  readonly version?: string;
}

export async function installAdapters(args: InstallArgs): Promise<readonly AdapterOutcome[]> {
  const instructions = renderAgentInstructions({ invocation: args.invocation });
  const outcomes: AdapterOutcome[] = [];

  outcomes.push(await writeBlock(args.root, 'AGENTS.md', 'agents', instructions));

  if (args.all === true || (await usesClaude(args.root))) {
    outcomes.push(await writeBlock(args.root, 'CLAUDE.md', 'claude', instructions));
  }

  if (args.all === true || (await exists(path.join(args.root, '.cursor')))) {
    // Cursor rules are whole files rather than blocks in a shared file, so
    // there is nothing of the team's to preserve inside one docgen owns.
    outcomes.push(
      await writeWholeFile(
        args.root,
        path.posix.join('.cursor', 'rules', 'docgen.mdc'),
        'cursor',
        renderCursorRule({ invocation: args.invocation }),
      ),
    );
  }

  // The gate goes in only where GitHub Actions is already the CI. Writing a
  // workflow into a repo that uses something else is a file nobody runs and
  // nobody deletes.
  if (args.all === true || (await exists(path.join(args.root, '.github', 'workflows')))) {
    outcomes.push(
      await writeWholeFile(
        args.root,
        GITHUB_WORKFLOW_PATH,
        'ci',
        renderGithubWorkflow({
          defaultBranch: args.defaultBranch ?? 'main',
          // `npx docgen` is what `resolveInvocation` produces for a repo that
          // declares docgen as a dependency; anything else means CI has to
          // fetch it.
          local: args.invocation.startsWith('npx '),
          version: args.version ?? 'latest',
        }),
      ),
    );
  }

  // Only where docgen is a pinned dependency, and only when the repo has no
  // update policy of its own. Rewriting a team's dependabot config to add one
  // ecosystem is not something an install command should do.
  if (
    args.invocation.startsWith('npx ') &&
    (await exists(path.join(args.root, '.github'))) &&
    !(await exists(path.join(args.root, DEPENDABOT_PATH)))
  ) {
    outcomes.push(await writeWholeFile(args.root, DEPENDABOT_PATH, 'updates', renderDependabotConfig()));
  }

  return outcomes.sort((a, b) => compareStrings(a.file, b.file));
}

async function writeBlock(
  root: string,
  relative: string,
  id: AdapterId,
  body: string,
): Promise<AdapterOutcome> {
  const absolute = path.join(root, relative);
  const existing = await readOrEmpty(absolute);
  const result = upsertManagedBlock(existing, body);

  if (result.action !== 'unchanged') {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, result.contents.replace(/\r\n/g, '\n'), 'utf8');
  }

  return { id, file: relative, action: result.action };
}

async function writeWholeFile(
  root: string,
  relative: string,
  id: AdapterId,
  contents: string,
): Promise<AdapterOutcome> {
  const absolute = path.join(root, relative);
  const existing = await readOrEmpty(absolute);
  const normalised = contents.replace(/\r\n/g, '\n');

  if (existing === normalised) return { id, file: relative, action: 'unchanged' };

  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, normalised, 'utf8');
  return { id, file: relative, action: existing.length === 0 ? 'created' : 'updated' };
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Either the directory or the instruction file counts as evidence. */
async function usesClaude(root: string): Promise<boolean> {
  return (await exists(path.join(root, '.claude'))) || (await exists(path.join(root, 'CLAUDE.md')));
}
