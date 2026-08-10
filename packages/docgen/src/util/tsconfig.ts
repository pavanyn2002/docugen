import path from 'node:path';
import { ts } from './ts-ast.js';
import { toPosix } from './paths.js';

/**
 * TypeScript path aliases, read from the target repo's tsconfig.
 *
 * Modern TypeScript repos import almost entirely through aliases — `@/lib/db`
 * rather than `../../lib/db`. A resolver that only understands relative
 * specifiers sees none of those edges, which makes the import graph look empty:
 * every aliased module appears to be imported by nothing, and any cross-file
 * chain that passes through an alias breaks silently and loses its result.
 *
 * Read with the TypeScript compiler's own config reader rather than
 * JSON.parse, because tsconfig is JSONC — comments and trailing commas are
 * routine and would otherwise throw on a perfectly valid file.
 */

/** One `paths` entry, pre-split around its wildcard. */
export interface PathAlias {
  /** Text before the `*`, or the whole pattern when there is no wildcard. */
  readonly prefix: string;
  /** Text after the `*`. Empty when the pattern ends in `*` or has none. */
  readonly suffix: string;
  /** True when the pattern contained a `*`. */
  readonly hasWildcard: boolean;
  /**
   * Substitution targets, repo-relative and POSIX, each pre-split the same way.
   * A pattern may map to several targets; TypeScript tries them in order.
   */
  readonly targets: readonly { readonly prefix: string; readonly suffix: string }[];
}

/** How deep an `extends` chain may go before we stop following it. */
const MAX_EXTENDS_DEPTH = 8;

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'] as const;

interface RawCompilerOptions {
  readonly baseUrl?: unknown;
  readonly paths?: unknown;
}

/**
 * Read `compilerOptions.paths` from the repo root's tsconfig (or jsconfig),
 * following `extends`.
 *
 * Returns an empty list rather than throwing for every failure mode — no
 * config, unreadable config, no `paths` key. Alias resolution is an
 * enhancement to the import graph; a repo without it must still extract.
 */
export async function loadPathAliases(root: string): Promise<readonly PathAlias[]> {
  for (const name of CONFIG_NAMES) {
    const configPath = path.join(root, name);
    const resolved = readConfigChain(configPath, 0);
    if (resolved === undefined) continue;

    const paths = resolved.options.paths;
    if (paths === null || typeof paths !== 'object') continue;

    // `paths` is resolved against baseUrl when set, and against the directory
    // of the config that declared it otherwise — which is what Next.js and
    // Vite templates rely on, since they ship `paths` with no baseUrl at all.
    const baseUrl = typeof resolved.options.baseUrl === 'string' ? resolved.options.baseUrl : '.';
    const baseDir = path.resolve(path.dirname(resolved.file), baseUrl);

    return buildAliases(paths as Record<string, unknown>, root, baseDir);
  }

  return [];
}

/** Read one config and merge in whatever it extends. Nearest file wins. */
function readConfigChain(
  configPath: string,
  depth: number,
): { file: string; options: RawCompilerOptions } | undefined {
  if (depth >= MAX_EXTENDS_DEPTH) return undefined;

  // TypeScript compares this against its own internally normalised form and
  // hard-fails the assertion when they differ, which on Windows they always do.
  const normalised = toPosix(configPath);

  let read: ReturnType<typeof ts.readConfigFile>;
  try {
    read = ts.readConfigFile(normalised, (file) => ts.sys.readFile(file));
  } catch {
    // A malformed tsconfig is the target repo's problem to fix, not a reason
    // to abandon extraction. Without aliases the import graph is poorer, and
    // that is already reported as unresolved imports.
    return undefined;
  }

  if (read.error !== undefined || read.config === null || typeof read.config !== 'object') {
    return undefined;
  }

  const config = read.config as { compilerOptions?: RawCompilerOptions; extends?: unknown };
  const own = config.compilerOptions ?? {};

  // A config that declares `paths` itself needs no parent: TypeScript does not
  // merge the two, the nearest declaration replaces the inherited one.
  if (own.paths !== undefined) return { file: configPath, options: own };

  if (typeof config.extends === 'string' && config.extends.startsWith('.')) {
    const parentPath = path.resolve(path.dirname(configPath), config.extends);
    for (const candidate of [parentPath, `${parentPath}.json`]) {
      const parent = readConfigChain(candidate, depth + 1);
      if (parent !== undefined) return parent;
    }
  }

  return { file: configPath, options: own };
}

function buildAliases(
  paths: Record<string, unknown>,
  root: string,
  baseDir: string,
): readonly PathAlias[] {
  const aliases: PathAlias[] = [];

  // Sorted so resolution order — and therefore output — does not depend on the
  // key order of the config file.
  for (const pattern of Object.keys(paths).sort()) {
    const rawTargets = paths[pattern];
    if (!Array.isArray(rawTargets)) continue;

    const split = splitPattern(pattern);
    const targets: { prefix: string; suffix: string }[] = [];

    for (const rawTarget of rawTargets) {
      if (typeof rawTarget !== 'string') continue;
      const target = splitPattern(rawTarget);

      // Make the target repo-relative, so it can be matched against the file
      // set the extractor scanned. A target outside the repo cannot resolve.
      const absolutePrefix = path.resolve(baseDir, target.prefix);
      const relativePrefix = toPosix(path.relative(root, absolutePrefix));
      if (relativePrefix.startsWith('..') || path.isAbsolute(relativePrefix)) continue;

      targets.push({ prefix: relativePrefix, suffix: target.suffix });
    }

    if (targets.length === 0) continue;
    aliases.push({ ...split, targets });
  }

  // Longest prefix first: `@/components/*` must win over `@/*` for a specifier
  // both could match, which is also how TypeScript picks.
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
}

function splitPattern(pattern: string): { prefix: string; suffix: string; hasWildcard: boolean } {
  const star = pattern.indexOf('*');
  if (star === -1) return { prefix: pattern, suffix: '', hasWildcard: false };
  return { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), hasWildcard: true };
}

/**
 * Substitute a specifier through the aliases, returning candidate
 * repo-relative paths in the order TypeScript would try them.
 *
 * Returns paths only — whether one exists is the caller's business, because
 * only the caller knows which files were actually scanned.
 */
export function aliasCandidates(
  specifier: string,
  aliases: readonly PathAlias[],
): readonly string[] {
  const candidates: string[] = [];

  for (const alias of aliases) {
    if (!specifier.startsWith(alias.prefix)) continue;

    let matched: string;
    if (alias.hasWildcard) {
      if (!specifier.endsWith(alias.suffix)) continue;
      const start = alias.prefix.length;
      const end = specifier.length - alias.suffix.length;
      if (end < start) continue;
      matched = specifier.slice(start, end);
    } else {
      if (specifier !== alias.prefix) continue;
      matched = '';
    }

    for (const target of alias.targets) {
      const joined = alias.hasWildcard
        ? `${target.prefix}${target.prefix === '' || target.prefix.endsWith('/') ? '' : '/'}${matched}${target.suffix}`
        : `${target.prefix}${target.suffix}`;
      candidates.push(toPosix(path.posix.normalize(joined)));
    }
  }

  return candidates;
}
