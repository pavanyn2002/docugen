import type { EvidenceGraph, GraphNodeKind } from '../graph/types.js';
import type { EntryBase, ExtractResult, ExtractorId } from '../types/core.js';
import type {
  ConfigEntry,
  EndpointEntry,
  JobEntry,
  ModuleEntry,
  RouteEntry,
  SchemaEntry,
} from '../types/entries.js';
import { DocgenError } from '../util/errors.js';

const NODE_KIND_BY_EXTRACTOR: Readonly<Partial<Record<ExtractorId, GraphNodeKind>>> = {
  routes: 'route',
  endpoints: 'endpoint',
  schema: 'schema',
  deps: 'module',
  jobs: 'job',
  config: 'config',
};

type EntryByExtractor = {
  routes: RouteEntry;
  endpoints: EndpointEntry;
  schema: SchemaEntry;
  deps: ModuleEntry;
  jobs: JobEntry;
  config: ConfigEntry;
};

/**
 * Replace extractor entries with the lossless entries carried by graph nodes.
 * Applicability, provider detection, skips, and extractor-specific diagnostics
 * remain envelope metadata; the documentation facts themselves come from the
 * canonical evidence graph.
 */
export function projectRenderResults(
  graph: EvidenceGraph,
  results: ReadonlyMap<ExtractorId, ExtractResult>,
): ReadonlyMap<ExtractorId, ExtractResult> {
  const projected = new Map<ExtractorId, ExtractResult>();
  for (const [extractor, result] of results) {
    projected.set(extractor, projectUntypedResult(graph, extractor, result));
  }
  return projected;
}

export function projectResult<T extends keyof EntryByExtractor>(
  graph: EvidenceGraph,
  extractor: T,
  envelope: ExtractResult<EntryByExtractor[T]>,
): ExtractResult<EntryByExtractor[T]> {
  return projectUntypedResult(graph, extractor, envelope) as ExtractResult<EntryByExtractor[T]>;
}

function projectUntypedResult(
  graph: EvidenceGraph,
  extractor: ExtractorId,
  envelope: ExtractResult,
): ExtractResult {
  const kind = NODE_KIND_BY_EXTRACTOR[extractor];
  const entries = graph.nodes
    .filter(
      (node) =>
        node.kind === kind &&
        node.provenance.origin === 'extracted' &&
        node.provenance.extractors?.includes(extractor) === true,
    )
    .map((node) => parseEntry<EntryBase>(node.id, node.properties?.['renderEntryV1']))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const expectedIds = envelope.entries.map((entry) => entry.id).sort();
  const projectedIds = entries.map((entry) => entry.id).sort();
  if (JSON.stringify(projectedIds) !== JSON.stringify(expectedIds)) {
    throw new DocgenError({
      code: 'graph-render-projection-incomplete',
      message: `Graph projection for '${extractor}' does not match the extracted entry identities.`,
      remedy: 'Rebuild the evidence graph with the current Docugen version before rendering.',
    });
  }
  return { ...envelope, entries };
}

function parseEntry<T>(nodeId: string, value: unknown): T {
  if (typeof value !== 'string') {
    throw new DocgenError({
      code: 'graph-render-projection-missing',
      message: `Graph node '${nodeId}' has no renderEntryV1 projection.`,
      remedy: 'Rebuild the evidence graph with the current Docugen version before rendering.',
    });
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new DocgenError({
      code: 'graph-render-projection-invalid',
      message: `Graph node '${nodeId}' has an invalid renderEntryV1 projection.`,
      remedy: 'Rebuild the evidence graph from source; do not hand-edit the graph cache.',
    });
  }
}
