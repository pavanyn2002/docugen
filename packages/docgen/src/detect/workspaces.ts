import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import { toPosix } from '../util/paths.js';
import { compareStrings } from '../util/sort.js';

/**
 * Sub-project discovery.
 *
 * Real repos are frequently not a single project at the root: `backend/` plus
 * `frontend/`, or a packages/* workspace. Looking only at the repo root means
 * detecting nothing at all in those repos and emitting empty documentation
 * that reads as a clean result.
 */

/** Manifest files that mark a directory as the root of a project. */
export const MANIFEST_FILES: readonly string[] = Object.freeze([
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'Pipfile',
  'go.mod',
  'Gemfile',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Cargo.toml',
  'pubspec.yaml',
  'mix.exs',
]);

export interface Workspace {
  /** Repo-relative POSIX directory. '' for the repo root. */
  readonly dir: string;
  /** Manifest file names found here, sorted. */
  readonly manifests: readonly string[];
}

/**
 * Find every directory containing a project manifest.
 *
 * Depth is bounded: a manifest nested ten levels down is almost always vendored
 * or a fixture, and walking without a bound makes large repos slow.
 */
export async function findWorkspaces(
  root: string,
  exclude: readonly string[],
  maxDepth = 3,
): Promise<readonly Workspace[]> {
  const patterns = MANIFEST_FILES.map((name) => `**/${name}`);
  const matches = await fg(patterns, {
    cwd: root,
    ignore: [...exclude],
    deep: maxDepth + 1,
    onlyFiles: true,
    dot: false,
  });

  const byDir = new Map<string, Set<string>>();
  for (const match of matches.map(toPosix)) {
    const dir = path.posix.dirname(match);
    const key = dir === '.' ? '' : dir;
    const bucket = byDir.get(key);
    if (bucket === undefined) byDir.set(key, new Set([path.posix.basename(match)]));
    else bucket.add(path.posix.basename(match));
  }

  // The root always counts as a workspace, so a repo with no manifest anywhere
  // is still scanned rather than skipped outright.
  if (!byDir.has('')) byDir.set('', new Set());

  return [...byDir.entries()]
    .map(([dir, manifests]) => ({ dir, manifests: [...manifests].sort() }))
    .sort((a, b) =>compareStrings(a.dir, b.dir));
}

/** Read a file, returning undefined when it is absent. */
export async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}
