import picomatch from 'picomatch';
import { EvidenceGraphBuilder } from '../graph/builder.js';
import { graphEdgeId, graphNodeId } from '../graph/ids.js';
import type { EvidenceGraph, GraphNode, GraphProvenance } from '../graph/types.js';
import type { StoredFeatureRecord } from './schema.js';

function featureProvenance(record: StoredFeatureRecord): GraphProvenance {
  return {
    origin: 'human',
    evidence: [{ file: record.sourceFile }],
    actor: record.recordedBy,
    recordedAt: record.recordedAt,
  };
}

export function featureNodeId(id: string): string {
  return graphNodeId('feature', id);
}

export function matchingFeatureNodeIds(
  graph: EvidenceGraph,
  record: StoredFeatureRecord,
): readonly string[] {
  const exact = new Set(record.selectors.nodes);
  const fileMatcher =
    record.selectors.files.length === 0
      ? undefined
      : picomatch([...record.selectors.files], { dot: true });

  return graph.nodes
    .filter((node) => node.kind !== 'feature')
    .filter((node) => {
      if (exact.has(node.id)) return true;
      if (fileMatcher === undefined) return false;
      if (node.kind === 'file' && fileMatcher(node.label)) return true;
      return node.provenance.evidence.some((ref) => fileMatcher(ref.file));
    })
    .map((node) => node.id);
}

export interface FeatureGraphMapping {
  readonly graph: EvidenceGraph;
  readonly matchedNodes: ReadonlyMap<string, readonly GraphNode[]>;
}

/** Add human-approved feature identity and membership to an extracted graph. */
export function mapFeaturesIntoGraph(
  graph: EvidenceGraph,
  records: readonly StoredFeatureRecord[],
): FeatureGraphMapping {
  const builder = new EvidenceGraphBuilder();
  for (const node of graph.nodes) builder.addNode(node);
  for (const edge of graph.edges) builder.addEdge(edge);
  for (const gap of graph.gaps) builder.addGap(gap);

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const matchedNodes = new Map<string, readonly GraphNode[]>();
  for (const record of records) {
    const id = featureNodeId(record.id);
    const provenance = featureProvenance(record);
    builder.addNode({
      id,
      kind: 'feature',
      label: record.title,
      provenance,
      properties: {
        featureId: record.id,
        aliases: record.aliases,
        status: record.status,
        owners: record.owners,
        criticality: record.criticality,
        ...(record.description === undefined ? {} : { description: record.description }),
      },
    });
    const matches = matchingFeatureNodeIds(graph, record)
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is GraphNode => node !== undefined);
    matchedNodes.set(record.id, matches);
    for (const node of matches) {
      builder.addEdge({
        id: graphEdgeId('belongs-to-feature', node.id, id),
        kind: 'belongs-to-feature',
        from: node.id,
        to: id,
        provenance,
      });
    }
  }
  return { graph: builder.build(), matchedNodes };
}

export function findFeatureRecord(
  records: readonly StoredFeatureRecord[],
  idOrAlias: string,
): StoredFeatureRecord | undefined {
  return records.find((record) => record.id === idOrAlias || record.aliases.includes(idOrAlias));
}
