import type { Workspace } from './workspaces.js';
import { compareStrings } from '../util/sort.js';

/** Stable display label for the repository-root workspace. */
export function workspaceLabel(workspace: string): string {
  return workspace === '' ? 'repo root' : workspace;
}

/** Return the nearest manifest directory that owns a repo-relative POSIX file. */
export function owningWorkspace(file: string, workspaces: readonly Workspace[]): string {
  const normalised = file.replaceAll('\\', '/').replace(/^\.\//, '');
  return workspaces
    .map((workspace) => workspace.dir)
    .filter((dir) => dir === '' || normalised === dir || normalised.startsWith(`${dir}/`))
    .sort((a, b) => b.length - a.length || compareStrings(a, b))[0] ?? '';
}

/** Deterministic runtime-scope identity. */
export function applicationScope(workspace: string, kind: string, root: string): string {
  return [workspace || '.', kind, root].join(':');
}
