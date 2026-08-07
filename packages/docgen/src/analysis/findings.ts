import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunResult } from '../pipeline.js';
import type {
  ConfigResult,
  DepsResult,
  RoutesResult,
  SchemaResult,
} from '../types/entries.js';
import type { SourceRef } from '../types/core.js';
import { toPosix } from '../util/paths.js';
import { compareStrings } from '../util/sort.js';

/**
 * Cross-extractor findings (SPEC 6.4).
 *
 * These compare one extractor's output against another's, which is where the
 * genuinely useful signal lives: a route with no component, a module nothing
 * imports, a table no code mentions, a variable nobody reads.
 *
 * Each is phrased as an observation with its evidence, never as a verdict.
 * "Nothing imports this module" is a fact; "this module is dead code" is a
 * conclusion that needs a human who knows whether it is loaded dynamically.
 */

export interface FindingItem {
  readonly label: string;
  readonly detail?: string;
  readonly source?: SourceRef;
}

export interface Finding {
  readonly id: string;
  readonly title: string;
  /** What this compares, and what it does *not* prove. */
  readonly description: string;
  readonly items: readonly FindingItem[];
  /** True when docgen lacked the inputs to run this analysis at all. */
  readonly unavailable?: string;
}

export interface FindingsReport {
  readonly findings: readonly Finding[];
  readonly totalItems: number;
}

/** Entry points that are reachable by definition, not by import. */
const ENTRY_POINT_PATTERN =
  /(?:^|\/)(?:index|main|server|app|cli|worker|middleware|instrumentation)\.[cm]?[jt]sx?$/i;

const CONFIG_FILE_PATTERN = /\.(?:config|conf)\.[cm]?[jt]s$/i;

export async function computeFindings(run: RunResult): Promise<FindingsReport> {
  const routes = run.results.get('routes') as RoutesResult | undefined;
  const schema = run.results.get('schema') as SchemaResult | undefined;
  const config = run.results.get('config') as ConfigResult | undefined;
  const deps = run.results.get('deps') as DepsResult | undefined;

  const findings: Finding[] = [
    await deadRoutes(run.config.root, routes),
    unreachableModules(deps, routes),
    await unreferencedTables(run.config.root, schema, run.config.effectiveExclude),
    envDeclaredNeverRead(config),
    envReadNeverDeclared(config),
  ];

  return {
    findings,
    totalItems: findings.reduce((total, finding) => total + finding.items.length, 0),
  };
}

/** Routes whose backing component file is not on disk. */
async function deadRoutes(root: string, routes: RoutesResult | undefined): Promise<Finding> {
  const base = {
    id: 'dead-routes',
    title: 'Routes with no component file',
    description:
      'The route is declared but the file backing it could not be found. This usually means a ' +
      'renamed or deleted component that the router still points at.',
  };

  if (routes === undefined || !routes.applicable) {
    return { ...base, items: [], unavailable: 'No routes were extracted from this repository.' };
  }

  const items: FindingItem[] = [];
  for (const route of routes.entries) {
    const target = route.component ?? route.source;
    try {
      await fs.access(path.join(root, target.file));
    } catch {
      items.push({
        label: route.path,
        detail: `component file missing: ${target.file}`,
        source: route.source,
      });
    }
  }
  return { ...base, items };
}

/**
 * Internal modules that nothing imports.
 *
 * Entry points and config files are excluded, since they are loaded by a
 * framework or a tool rather than by an import. Anything left is a candidate
 * for removal — but only a candidate: dynamic requires and framework
 * conventions can both make a module reachable invisibly.
 */
function unreachableModules(
  deps: DepsResult | undefined,
  routes: RoutesResult | undefined,
): Finding {
  const base = {
    id: 'unreachable-modules',
    title: 'Modules nothing imports',
    description:
      'No other module in the repository imports these. Entry points, config files, and route ' +
      'files are excluded. A framework that loads files by convention, or a dynamic import built ' +
      'from a variable, would make a module reachable in a way this cannot see.',
  };

  if (deps === undefined || !deps.applicable) {
    return { ...base, items: [], unavailable: 'The module graph was not extracted.' };
  }

  const imported = new Set<string>();
  for (const entry of deps.entries) {
    for (const target of entry.imports) imported.add(target);
  }

  // A route file is reached by the router, not by an import.
  const routeFiles = new Set<string>();
  for (const route of routes?.entries ?? []) {
    routeFiles.add(route.source.file);
    if (route.component !== undefined) routeFiles.add(route.component.file);
  }

  const items = deps.entries
    .filter((entry) => !imported.has(entry.module))
    .filter((entry) => !routeFiles.has(entry.module))
    .filter((entry) => !ENTRY_POINT_PATTERN.test(entry.module))
    .filter((entry) => !CONFIG_FILE_PATTERN.test(entry.module))
    .map((entry) => ({ label: entry.module, source: { file: entry.module } }));

  return { ...base, items };
}

/**
 * Tables and collections whose name appears nowhere outside their definition.
 *
 * A real text scan rather than an import check: a model file can be imported
 * while the model itself is never queried, and the name is what a reader would
 * grep for.
 */
async function unreferencedTables(
  root: string,
  schema: SchemaResult | undefined,
  exclude: readonly string[],
): Promise<Finding> {
  const base = {
    id: 'unreferenced-tables',
    title: 'Tables never mentioned outside their definition',
    description:
      'The name does not appear in any source file other than the one that defines it. The table ' +
      'may still be read by raw SQL, by a name built at runtime, or by another service entirely.',
  };

  if (schema === undefined || !schema.applicable || schema.entries.length === 0) {
    return { ...base, items: [], unavailable: 'No database schema was extracted.' };
  }

  const files = (
    await fg(['**/*.{ts,tsx,js,jsx,mjs,cjs,py,sql}'], {
      cwd: root,
      ignore: [...exclude],
      onlyFiles: true,
    })
  ).map(toPosix);

  // One pass over the sources, checking every table name per file, rather than
  // re-reading the repository once per table.
  const seenOutsideDefinition = new Map<string, boolean>();
  const namesByEntry = schema.entries.map((entry) => ({
    entry,
    needles: [entry.name, entry.modelName].filter((name): name is string => name !== undefined),
  }));
  for (const { entry } of namesByEntry) seenOutsideDefinition.set(entry.id, false);

  for (const relative of files) {
    let contents: string;
    try {
      contents = await fs.readFile(path.join(root, relative), 'utf8');
    } catch {
      continue;
    }

    for (const { entry, needles } of namesByEntry) {
      if (seenOutsideDefinition.get(entry.id) === true) continue;
      if (relative === entry.source.file) continue;
      if (needles.some((needle) => containsWord(contents, needle))) {
        seenOutsideDefinition.set(entry.id, true);
      }
    }
  }

  const items = schema.entries
    .filter((entry) => seenOutsideDefinition.get(entry.id) !== true)
    .map((entry) => ({
      label: entry.name,
      detail: `defined in ${entry.source.file}`,
      source: entry.source,
    }));

  return { ...base, items };
}

/** Whole-word match, so `User` does not match `UserProfile`. */
function containsWord(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(haystack);
}

function envDeclaredNeverRead(config: ConfigResult | undefined): Finding {
  const base = {
    id: 'env-declared-never-read',
    title: 'Environment variables declared but never read',
    description: 'Declared in a .env file, but nothing in the code reads them.',
  };

  if (config === undefined || !config.applicable) {
    return { ...base, items: [], unavailable: 'No configuration was extracted.' };
  }

  const items = config.entries
    .filter((entry) => entry.declarations.length > 0 && entry.reads.length === 0)
    .map((entry) => ({
      label: entry.name,
      detail: `declared in ${entry.declarations.map((ref) => ref.file).join(', ')}`,
      ...(entry.declarations[0] === undefined ? {} : { source: entry.declarations[0] }),
    }));

  return { ...base, items };
}

function envReadNeverDeclared(config: ConfigResult | undefined): Finding {
  const base = {
    id: 'env-read-never-declared',
    title: 'Environment variables read but never declared',
    description:
      'Read by the code but present in no .env file. They may be supplied by the deployment ' +
      'environment, or they may be missing — this cannot tell which.',
  };

  if (config === undefined || !config.applicable) {
    return { ...base, items: [], unavailable: 'No configuration was extracted.' };
  }

  const items = config.entries
    .filter((entry) => entry.reads.length > 0 && entry.declarations.length === 0)
    .map((entry) => ({
      label: entry.name,
      detail: `read at ${entry.reads.length} site(s)`,
      ...(entry.reads[0] === undefined ? {} : { source: entry.reads[0] }),
    }));

  return { ...base, items };
}

/** Stable ordering for rendering. */
export function sortItems(items: readonly FindingItem[]): readonly FindingItem[] {
  return [...items].sort((a, b) => compareStrings(a.label, b.label));
}
