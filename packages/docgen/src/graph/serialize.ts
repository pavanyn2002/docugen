import { EvidenceGraphBuilder } from './builder.js';
import type { EvidenceGraph } from './types.js';

/** Canonical JSON used for snapshots, interchange, and determinism checks. */
export function serialiseEvidenceGraph(graph: EvidenceGraph): string {
  const builder = new EvidenceGraphBuilder();
  for (const node of graph.nodes) builder.addNode(node);
  for (const edge of graph.edges) builder.addEdge(edge);
  for (const gap of graph.gaps) builder.addGap(gap);
  return `${JSON.stringify(builder.build(), null, 2)}\n`;
}
