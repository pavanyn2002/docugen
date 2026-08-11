import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { toPosix } from './paths.js';

/**
 * SPEC rule 7: the Phase 0 static lane must not reach into the LLM lane.
 *
 * This is enforced as an executable check rather than a convention, because the
 * whole trust model collapses the moment an extractor can call a model: output
 * in `extract/` is stamped `verified`, and a `verified` claim produced by an
 * LLM is exactly the fabrication this tool exists to stop.
 */
export const LLM_LANE_DIRS: readonly string[] = Object.freeze(['infer', 'questions', 'agents']);

/** Directories that must never import from the LLM lane. */
export const STATIC_LANE_DIRS: readonly string[] = Object.freeze([
  'extract',
  'surface',
  'render',
  'config',
  'graph',
  'util',
  'types',
]);

export interface BoundaryViolation {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly reason: string;
}

/** Matches static `import`/`export ... from`, bare `import 'x'`, and dynamic `import('x')`. */
const IMPORT_PATTERN =
  /(?:^|\s)(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\s)import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveSpecifier(fromFile: string, srcRoot: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  return toPosix(path.relative(srcRoot, resolved));
}

/**
 * Scan `srcRoot` for imports that cross the static/LLM boundary.
 * Returns violations sorted for stable reporting; an empty array means clean.
 */
export async function findBoundaryViolations(srcRoot: string): Promise<readonly BoundaryViolation[]> {
  const files = await fg('**/*.ts', {
    cwd: srcRoot,
    absolute: true,
    ignore: ['**/*.d.ts'],
  });

  const violations: BoundaryViolation[] = [];

  for (const file of files.sort()) {
    const relative = toPosix(path.relative(srcRoot, file));
    const topDir = relative.split('/')[0] ?? '';
    if (!STATIC_LANE_DIRS.includes(topDir)) continue;

    const contents = await fs.readFile(file, 'utf8');
    const lines = contents.split(/\r?\n/);

    lines.forEach((text, index) => {
      for (const match of text.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
        if (specifier === undefined) continue;

        const target = resolveSpecifier(file, srcRoot, specifier);
        if (target === undefined) continue;

        const targetTop = target.split('/')[0] ?? '';
        if (LLM_LANE_DIRS.includes(targetTop)) {
          violations.push({
            file: relative,
            line: index + 1,
            specifier,
            reason: `${topDir}/ is the static lane and must not import from ${targetTop}/ (the LLM lane)`,
          });
        }
      }
    });
  }

  return violations;
}
