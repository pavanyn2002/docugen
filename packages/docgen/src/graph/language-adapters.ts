import fg from 'fast-glob';
import { DocgenError } from '../util/errors.js';
import { compareStrings } from '../util/sort.js';
import { validateEvidenceGraph } from './builder.js';
import { enrichGraphWithTypeScriptSymbols } from './symbols.js';
import type { EvidenceGraph } from './types.js';

export type SymbolParserBackend = 'typescript-compiler-api' | 'tree-sitter';

export interface SymbolLanguageAdapterContext {
  readonly graph: EvidenceGraph;
  readonly root: string;
  readonly exclude: readonly string[];
  /** Files whose symbol partitions may be emitted; all files remain available for resolution. */
  readonly partitionFiles?: ReadonlySet<string>;
}

/** Contract implemented by built-in analyzers and future Tree-sitter language adapters. */
export interface SymbolLanguageAdapter {
  readonly id: string;
  /** Bump when this adapter's output semantics change. */
  readonly version: string;
  readonly backend: SymbolParserBackend;
  readonly languages: readonly string[];
  readonly fileExtensions: readonly string[];
  enrich(context: SymbolLanguageAdapterContext): Promise<EvidenceGraph>;
}

export interface SymbolLanguageAdapterReport {
  readonly id: string;
  readonly version: string;
  readonly backend: SymbolParserBackend;
  readonly languages: readonly string[];
  readonly fileExtensions: readonly string[];
}

export interface SymbolLanguageAdapterRun {
  readonly graph: EvidenceGraph;
  readonly adapters: readonly SymbolLanguageAdapterReport[];
}

const typescriptAdapter: SymbolLanguageAdapter = {
  id: 'typescript-javascript',
  version: '4',
  backend: 'typescript-compiler-api',
  languages: ['TypeScript', 'JavaScript'],
  fileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  enrich: enrichGraphWithTypeScriptSymbols,
};

const pythonAdapter: SymbolLanguageAdapter = {
  id: 'python',
  version: '2',
  backend: 'tree-sitter',
  languages: ['Python'],
  fileExtensions: ['.py'],
  enrich: async (context) => {
    const files = await fg(['**/*.py'], {
      cwd: context.root,
      ignore: [...context.exclude],
      onlyFiles: true,
      followSymbolicLinks: false,
    });
    if (files.length === 0) return context.graph;
    const { enrichGraphWithPythonSymbols } = await import('./python-symbols.js');
    return enrichGraphWithPythonSymbols(context);
  },
};

const BUILT_IN_ADAPTERS: readonly SymbolLanguageAdapter[] = Object.freeze([
  pythonAdapter,
  typescriptAdapter,
]);

function validateAdapters(adapters: readonly SymbolLanguageAdapter[]): readonly SymbolLanguageAdapter[] {
  const sorted = [...adapters].sort((a, b) => compareStrings(a.id, b.id));
  const ids = new Set<string>();
  for (const adapter of sorted) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(adapter.id)) {
      throw new DocgenError({
        code: 'symbol-adapter-id-invalid',
        message: `Symbol adapter id '${adapter.id}' is invalid.`,
        remedy: 'Use a stable lowercase kebab-case adapter id.',
      });
    }
    if (ids.has(adapter.id)) {
      throw new DocgenError({
        code: 'symbol-adapter-id-duplicate',
        message: `Symbol adapter id '${adapter.id}' is registered more than once.`,
        remedy: 'Give every language adapter a unique stable id.',
      });
    }
    if (
      adapter.version.length === 0 ||
      adapter.languages.length === 0 ||
      adapter.fileExtensions.length === 0 ||
      adapter.fileExtensions.some((extension) => !extension.startsWith('.'))
    ) {
      throw new DocgenError({
        code: 'symbol-adapter-metadata-invalid',
        message: `Symbol adapter '${adapter.id}' has incomplete capability metadata.`,
        remedy: 'Declare a version, at least one language, and dot-prefixed file extensions.',
      });
    }
    ids.add(adapter.id);
  }
  return sorted;
}

function report(adapter: SymbolLanguageAdapter): SymbolLanguageAdapterReport {
  return {
    id: adapter.id,
    version: adapter.version,
    backend: adapter.backend,
    languages: [...adapter.languages].sort(compareStrings),
    fileExtensions: [...adapter.fileExtensions].sort(compareStrings),
  };
}

export function getSymbolLanguageAdapters(): readonly SymbolLanguageAdapter[] {
  return validateAdapters(BUILT_IN_ADAPTERS);
}

export function getSymbolLanguageAdapterReports(): readonly SymbolLanguageAdapterReport[] {
  return getSymbolLanguageAdapters().map(report);
}

/** Apply adapters deterministically and reject an invalid graph at the adapter boundary. */
export async function applySymbolLanguageAdapters(options: {
  readonly graph: EvidenceGraph;
  readonly root: string;
  readonly exclude: readonly string[];
  readonly partitionFiles?: ReadonlySet<string>;
  /** Dependency injection for plugins and contract tests. */
  readonly adapters?: readonly SymbolLanguageAdapter[];
}): Promise<SymbolLanguageAdapterRun> {
  const adapters = validateAdapters(options.adapters ?? BUILT_IN_ADAPTERS);
  let graph = options.graph;
  for (const adapter of adapters) {
    graph = await adapter.enrich({
      graph,
      root: options.root,
      exclude: options.exclude,
      ...(options.partitionFiles === undefined ? {} : { partitionFiles: options.partitionFiles }),
    });
    const issues = validateEvidenceGraph(graph);
    if (issues.length > 0) {
      throw new DocgenError({
        code: 'symbol-adapter-graph-invalid',
        message: `Symbol adapter '${adapter.id}' returned an invalid evidence graph: ${issues[0]?.message ?? 'unknown validation failure'}`,
        remedy: 'Fix or disable the adapter; invalid language evidence is never accepted.',
      });
    }
  }
  return { graph, adapters: adapters.map(report) };
}
