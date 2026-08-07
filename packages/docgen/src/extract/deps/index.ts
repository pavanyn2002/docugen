import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap, Skip } from '../../types/core.js';
import type { DepsResult, ModuleEntry } from '../../types/entries.js';
import { resolveRelativeImport } from '../../util/modules.js';
import { toPosix } from '../../util/paths.js';
import { literalString, parseSourceFile, ts } from '../../util/ts-ast.js';
import type { Extractor, ExtractorContext } from '../types.js';
import { inapplicable, skip } from '../types.js';
import { compareStrings } from '../../util/sort.js';

/**
 * The internal module dependency graph.
 *
 * Only imports that resolve to a file in the repo become edges; bare package
 * specifiers are recorded separately as externals, since a graph mixing the two
 * is unreadable and answers neither question well.
 */
/** Non-code imports: real in a bundler, but not edges in a module graph. */
const ASSET_EXTENSION =
  /\.(?:json|css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|md|txt|ya?ml|graphql|gql|wasm)$/i;

export const depsExtractor: Extractor<ModuleEntry> = {
  id: 'deps',
  title: 'Module dependency graph',

  async run(context: ExtractorContext): Promise<DepsResult> {
    const startedAt = Date.now();
    const exclude = context.config.effectiveExclude;

    const files = (
      await fg(['**/*.{ts,tsx,js,jsx,mjs,cjs}'], { cwd: context.root, ignore: [...exclude], onlyFiles: true })
    )
      .map(toPosix)
      .sort();

    if (files.length === 0) {
      return {
        ...inapplicable<ModuleEntry>(
          'deps',
          [skip('deps', 'no-source-files', 'No JavaScript or TypeScript source files were found.')],
          Date.now() - startedAt,
        ),
        cycles: [],
      };
    }

    const fileSet = new Set(files);
    const entries: ModuleEntry[] = [];
    const gaps: Gap[] = [];
    const skips: Skip[] = [];

    for (const relative of files) {
      let contents: string;
      try {
        contents = await fs.readFile(path.join(context.root, relative), 'utf8');
      } catch {
        continue;
      }

      const source = parseSourceFile(relative, contents);
      const internal = new Set<string>();
      const externals = new Set<string>();
      const unresolved: string[] = [];

      for (const specifier of collectSpecifiers(source)) {
        if (!specifier.startsWith('.')) {
          // Trim a deep import to its package name: '@scope/pkg/sub' -> '@scope/pkg'.
          externals.add(packageNameOf(specifier));
          continue;
        }
        // An imported stylesheet or image is not a module-graph edge, and
        // reporting it as unresolved would bury the imports that matter.
        if (ASSET_EXTENSION.test(specifier)) continue;

        const resolved = resolveRelativeImport(relative, specifier, fileSet);
        if (resolved === undefined) unresolved.push(specifier);
        else if (resolved !== relative) internal.add(resolved);
      }

      if (unresolved.length > 0) {
        // Naming the specifiers is what makes this actionable: an import of a
        // directory that does not exist is a real defect, and one of a JSON
        // fixture is noise. Only the reader can tell them apart.
        gaps.push({
          extractor: 'deps',
          kind: 'import-unresolved',
          message:
            `${unresolved.length} import(s) do not resolve to a scanned source file: ` +
            `${[...new Set(unresolved)].sort().slice(0, 8).join(', ')}` +
            `${unresolved.length > 8 ? ', …' : ''}.`,
          source: { file: relative },
        });
      }

      entries.push({
        id: `module:${relative}`,
        source: { file: relative, line: 1 },
        extractionMethod: 'ast',
        certainty: 'high',
        module: relative,
        imports: [...internal].sort(),
        externals: [...externals].sort(),
      });
    }

    const cycles = findCycles(entries);
    if (cycles.length > 0) {
      gaps.push({
        extractor: 'deps',
        kind: 'import-cycle',
        message:
          `${cycles.length} import cycle(s) found. The shortest is: ` +
          `${(cycles[0] ?? []).join(' → ')}. Cycles make module initialisation order significant ` +
          'and are a common source of undefined-at-import bugs.',
      });
    }

    return {
      extractor: 'deps',
      applicable: true,
      detected: ['typescript-imports'],
      entries: entries.sort((a, b) =>compareStrings(a.module, b.module)),
      gaps: gaps.sort(
        (a, b) =>compareStrings(a.kind, b.kind) ||compareStrings((a.source?.file ?? ''), b.source?.file ?? ''),
      ),
      skips,
      cycles,
      durationMs: Date.now() - startedAt,
    };
  },
};

/** Static imports, re-exports, dynamic imports, and require calls. */
function collectSpecifiers(source: ts.SourceFile): readonly string[] {
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const value = literalString(node.moduleSpecifier);
      if (value !== undefined) specifiers.push(value);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const value = literalString(node.arguments[0]);
        if (value !== undefined) specifiers.push(value);
      }
    }
    node.forEachChild(visit);
  };

  visit(source);
  return specifiers;
}

export function packageNameOf(specifier: string): string {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0] ?? specifier;
}

/**
 * Find import cycles with an iterative depth-first search.
 *
 * Iterative rather than recursive because a deep module graph would overflow
 * the stack on a large repo. Each cycle is reported once, keyed by its member
 * set, and returned in a canonical rotation so output stays deterministic.
 */
export function findCycles(entries: readonly ModuleEntry[]): readonly (readonly string[])[] {
  const graph = new Map<string, readonly string[]>();
  for (const entry of entries) graph.set(entry.module, entry.imports);

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const found = new Map<string, readonly string[]>();

  for (const start of [...graph.keys()].sort()) {
    if ((colour.get(start) ?? WHITE) !== WHITE) continue;

    const stack: { node: string; index: number }[] = [{ node: start, index: 0 }];
    const pathStack: string[] = [start];
    colour.set(start, GREY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { node: string; index: number };
      const neighbours = graph.get(frame.node) ?? [];

      if (frame.index >= neighbours.length) {
        colour.set(frame.node, BLACK);
        stack.pop();
        pathStack.pop();
        continue;
      }

      const next = neighbours[frame.index] as string;
      frame.index += 1;
      if (!graph.has(next)) continue;

      const state = colour.get(next) ?? WHITE;
      if (state === GREY) {
        const at = pathStack.lastIndexOf(next);
        if (at === -1) continue;
        const cycle = pathStack.slice(at);
        const key = [...cycle].sort().join('|');
        if (!found.has(key)) found.set(key, canonicalRotation(cycle));
        continue;
      }
      if (state === BLACK) continue;

      colour.set(next, GREY);
      pathStack.push(next);
      stack.push({ node: next, index: 0 });
    }
  }

  return [...found.values()].sort(
    (a, b) => a.length - b.length || compareStrings(a.join('|'), b.join('|')),
  );
}

/** Rotate a cycle to start at its lexically smallest member, so it is stable. */
function canonicalRotation(cycle: readonly string[]): readonly string[] {
  let smallest = 0;
  for (let index = 1; index < cycle.length; index += 1) {
    if ((cycle[index] as string) < (cycle[smallest] as string)) smallest = index;
  }
  return [...cycle.slice(smallest), ...cycle.slice(0, smallest)];
}
