import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import picomatch from 'picomatch';
import { toPosix } from '../util/paths.js';

/**
 * The repo's own ignore rules, as glob patterns.
 *
 * Without this, docgen reads whatever happens to be sitting in the working
 * directory: build output, release staging copies, local scratch files. Two
 * separate things go wrong when it does.
 *
 * The first is accuracy. A stale copy of the migrations under `output/` is
 * documented as though it were the schema, and every link in the committed
 * documentation points at a path that does not exist for anyone who clones the
 * repo.
 *
 * The second is worse, because it undermines the guarantee the tool is built
 * on. Untracked files are not part of the commit, so the same commit produces
 * different output on two machines depending on what each happens to have
 * built. `docgen check` then fails in CI — which clones clean — for a reason
 * nobody can see in the diff.
 */

export interface GitignoreRules {
  /** fast-glob `ignore` patterns, sorted for deterministic config output. */
  readonly patterns: readonly string[];
  /**
   * Retained for compatibility. Ordered re-inclusion rules are now supported.
   */
  readonly unsupportedNegations: readonly string[];
}

const EMPTY: GitignoreRules = Object.freeze({
  patterns: Object.freeze([]),
  unsupportedNegations: Object.freeze([]),
});

/**
 * Read `.gitignore` at the repo root.
 *
 * Root only, deliberately: nested ignore files would have to be discovered by
 * globbing the very tree we are trying to bound, and the root file is what
 * carries build output in practice. A repo whose ignores live only in a
 * subdirectory still gets ALWAYS_EXCLUDE.
 *
 * A missing or unreadable file is not an error — plenty of repos have neither.
 */
export async function readGitignore(root: string, exclude: readonly string[] = []): Promise<GitignoreRules> {
  let contents: string;
  try {
    contents = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  } catch {
    return EMPTY;
  }
  const parsed = parseGitignore(contents);
  if (!contents.split(/\r?\n/).some(line => line.startsWith('!'))) return parsed;
  // Fast-glob cannot restore pruned files. Evaluate ordered rules first, then
  // pass literal ignored filenames to every existing extraction consumer.
  const ignores = gitignoreMatcher(contents);
  const files = await fg('**/*', { cwd: root, ignore: [...exclude], dot: true, onlyFiles: true });
  return {
    patterns: files.map(toPosix).filter(ignores).map(file => fg.escapePath(file)).sort(),
    unsupportedNegations: [],
  };
}

/** Positive-rule globs; readGitignore resolves ordered negations against files. */
export function parseGitignore(contents: string): GitignoreRules {
  const patterns = new Set<string>();

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = stripTrailingSpace(rawLine);
    if (line === '' || line.startsWith('#')) continue;

    if (line.startsWith('!')) {
      continue;
    }

    // `\#literal` and `\!literal` escape a leading marker character.
    const pattern = line.startsWith('\\') ? line.slice(1) : line;
    for (const glob of toGlobs(pattern)) patterns.add(glob);
  }

  return {
    patterns: [...patterns].sort(),
    unsupportedNegations: [],
  };
}

/**
 * One gitignore pattern to the fast-glob patterns that cover it.
 *
 * A directory rule has to match its contents rather than the directory node,
 * because every caller globs with `onlyFiles`. A name with no slash matches at
 * any depth; anything anchored by a leading or interior slash matches only
 * from the root, which is why each case emits a different shape.
 */
function toGlobs(pattern: string): readonly string[] {
  const isDirectoryOnly = pattern.endsWith('/');
  const body = trimSlashes(pattern);
  if (body === '') return [];

  // A leading slash anchors to the root; so does any interior slash, per
  // gitignore's own rule that `a/b` is a path and `b` is a name.
  const isAnchored = pattern.startsWith('/') || body.includes('/');
  const base = isAnchored ? body : `**/${body}`;

  return isDirectoryOnly ? [`${base}/**`] : [base, `${base}/**`];
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Trailing whitespace is insignificant unless escaped with a backslash. */
function stripTrailingSpace(line: string): string {
  return line.replace(/(?<!\\)\s+$/, '');
}

/** Git ignores cannot re-include a child of an excluded directory. */
export function gitignoreMatcher(contents: string): (file: string) => boolean {
  const rules = contents.split(/\r?\n/).map(stripTrailingSpace)
    .filter(line => line !== '' && !line.startsWith('#'))
    .map(line => {
      const negate = line.startsWith('!');
      const raw = negate ? line.slice(1) : line;
      const directoryOnly = raw.endsWith('/');
      const body = trimSlashes(raw);
      const anchored = raw.startsWith('/') || body.includes('/');
      // Git treats braces and extglobs literally, and matches dotfiles.
      const match = picomatch(anchored ? body : `**/${body}`, {
        dot: true, nonegate: true, noext: true, nobrace: true, strictSlashes: true,
      });
      return { negate, directoryOnly, match };
    });
  return file => {
    const parts = toPosix(file).split('/');
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const candidate = parts.slice(0, depth).join('/');
      const isDirectory = depth < parts.length;
      let ignored = false;
      for (const rule of rules) {
        if ((!rule.directoryOnly || isDirectory) && rule.match(candidate)) ignored = !rule.negate;
      }
      if (ignored) return true;
    }
    return false;
  };
}
