import fs from 'node:fs/promises';
import path from 'node:path';
import { compareStrings } from '../util/sort.js';
import { upsertManagedBlock } from './block.js';
import { renderAgentInstructions, renderCursorRule } from './instructions.js';

/**
 * Install the agent adapters.
 *
 * `AGENTS.md` is written always — it is the one file every current coding agent
 * reads, so it is the closest thing to a neutral target. Tool-specific files are
 * written only where the repository already shows that tool in use: creating a
 * `.cursor/` directory in a repo that has never used Cursor is clutter, and
 * clutter is how a tool gets uninstalled.
 */

export type AdapterId = 'agents' | 'claude' | 'cursor';

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
