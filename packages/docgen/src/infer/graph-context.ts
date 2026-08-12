import { EvidenceGraphIndex } from '../graph/query.js';
import { surfaceNodeId } from '../graph/surfaces.js';
import type { EvidenceGraph, GraphEdge, GraphNode } from '../graph/types.js';
import type { SourceRef } from '../types/core.js';
import { compareStrings } from '../util/sort.js';

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_NODES = 80;
const DEFAULT_MAX_EDGES = 160;

export interface GraphNeighborhood {
  readonly seedId: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly evidence: readonly SourceRef[];
  readonly truncated: boolean;
}

/** Select the bounded, extracted-only neighborhood that a model may see. */
export function selectGraphNeighborhood(args: {
  readonly graph: EvidenceGraph;
  readonly surfaceId: string;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxEdges?: number;
}): GraphNeighborhood | undefined {
  const seedId = surfaceNodeId(args.surfaceId);
  const index = new EvidenceGraphIndex(args.graph);
  const seed = index.getNode(seedId);
  if (seed === undefined || seed.provenance.origin !== 'extracted') return undefined;

  const maxDepth = args.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = args.maxNodes ?? DEFAULT_MAX_NODES;
  const maxEdges = args.maxEdges ?? DEFAULT_MAX_EDGES;
  const selectedNodes = new Map<string, GraphNode>([[seed.id, seed]]);
  const selectedEdges = new Map<string, GraphEdge>();
  const queue: Array<{ readonly id: string; readonly depth: number }> = [
    { id: seed.id, depth: 0 },
  ];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current.depth >= maxDepth) continue;
    for (const neighbor of index.neighbors(current.id)) {
      if (
        neighbor.node.provenance.origin !== 'extracted' ||
        neighbor.edge.provenance.origin !== 'extracted'
      ) {
        continue;
      }
      if (selectedEdges.size >= maxEdges) {
        truncated = true;
        continue;
      }
      selectedEdges.set(neighbor.edge.id, neighbor.edge);
      if (selectedNodes.has(neighbor.node.id)) continue;
      if (selectedNodes.size >= maxNodes) {
        truncated = true;
        continue;
      }
      selectedNodes.set(neighbor.node.id, neighbor.node);
      queue.push({ id: neighbor.node.id, depth: current.depth + 1 });
    }
  }

  const nodes = [...selectedNodes.values()].sort((a, b) => compareStrings(a.id, b.id));
  const edges = [...selectedEdges.values()]
    .filter((edge) => selectedNodes.has(edge.from) && selectedNodes.has(edge.to))
    .sort((a, b) => compareStrings(a.id, b.id));
  const evidence = uniqueEvidence([
    ...nodes.flatMap((node) => node.provenance.evidence),
    ...edges.flatMap((edge) => edge.provenance.evidence),
  ]);
  return { seedId, nodes, edges, evidence, truncated };
}

export function renderGraphNeighborhood(neighborhood: GraphNeighborhood | undefined): string {
  if (neighborhood === undefined) {
    return '_No extracted evidence-graph surface was available. Use only the static facts and source excerpts below._';
  }
  const lines = [
    `Seed: \`${neighborhood.seedId}\``,
    '',
    'Nodes:',
    ...neighborhood.nodes.map(
      (node) =>
        `- \`${node.id}\` [${node.kind}] ${node.label}${renderEvidence(node.provenance.evidence)}`,
    ),
    '',
    'Relationships:',
    ...(neighborhood.edges.length === 0
      ? ['- _None within the selected depth._']
      : neighborhood.edges.map(
          (edge) =>
            `- \`${edge.from}\` --${edge.kind}--> \`${edge.to}\`${renderEvidence(edge.provenance.evidence)}`,
        )),
  ];
  if (neighborhood.truncated) {
    lines.push('', '> The graph neighborhood hit its safety cap. Treat anything beyond it as unknown.');
  }
  return lines.join('\n');
}

function renderEvidence(evidence: readonly SourceRef[]): string {
  if (evidence.length === 0) return '';
  const refs = uniqueEvidence(evidence)
    .slice(0, 3)
    .map((ref) => `${ref.file}${ref.line === undefined ? '' : `:${ref.line}`}`);
  return ` (evidence: ${refs.join(', ')})`;
}

function uniqueEvidence(values: readonly SourceRef[]): readonly SourceRef[] {
  const byKey = new Map<string, SourceRef>();
  for (const value of values) {
    const key = `${value.file}\u0000${value.line ?? ''}\u0000${value.column ?? ''}`;
    byKey.set(key, value);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      compareStrings(a.file, b.file) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0),
  );
}
