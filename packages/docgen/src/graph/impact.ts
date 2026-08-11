import type { GitChangeSet, GitFileChange } from '../util/git.js';
import { DocgenError } from '../util/errors.js';
import { compareStrings } from '../util/sort.js';
import { EvidenceGraphIndex } from './query.js';
import type { EvidenceGraph, GraphEdge, GraphNode } from './types.js';

export interface ImpactedGraphNode {
  readonly node: GraphNode;
  /** Incoming relationships crossed from direct file evidence. Zero is direct. */
  readonly distance: number;
  readonly basis: readonly ('baseline' | 'current')[];
  readonly via?: GraphEdge;
}

export interface FileChangeImpact {
  readonly change: GitFileChange;
  readonly impacted: readonly ImpactedGraphNode[];
}

export interface ChangeImpactReport {
  readonly base: string;
  readonly maxDepth: number;
  readonly files: readonly FileChangeImpact[];
}

function evidenceMatches(file: string, evidence: readonly { readonly file: string }[]): boolean {
  return evidence.some((ref) => ref.file === file);
}

function impactInGraph(
  graph: EvidenceGraph,
  files: ReadonlySet<string>,
  maxDepth: number,
): ReadonlyMap<string, Omit<ImpactedGraphNode, 'basis'>> {
  const index = new EvidenceGraphIndex(graph);
  const seeds = new Set<string>();
  const matchesChangedFile = (evidence: readonly { readonly file: string }[]): boolean =>
    [...files].some((file) => evidenceMatches(file, evidence));
  for (const node of graph.nodes) {
    if (
      (files.has(node.label) && node.kind === 'file') ||
      matchesChangedFile(node.provenance.evidence)
    ) {
      seeds.add(node.id);
    }
  }
  for (const edge of graph.edges) {
    if (matchesChangedFile(edge.provenance.evidence)) {
      seeds.add(edge.from);
      seeds.add(edge.to);
    }
  }

  const found = new Map<string, Omit<ImpactedGraphNode, 'basis'>>();
  const queue: { readonly id: string; readonly distance: number }[] = [];
  for (const id of [...seeds].sort(compareStrings)) {
    const node = index.getNode(id);
    if (node === undefined) continue;
    found.set(id, { node, distance: 0 });
    queue.push({ id, distance: 0 });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current.distance >= maxDepth) continue;
    const neighbors = [
      ...index.neighbors(current.id, { direction: 'incoming' }),
      ...index
        .neighbors(current.id, { direction: 'outgoing', edgeKinds: ['belongs-to-feature'] }),
    ];
    for (const neighbor of neighbors) {
      if (found.has(neighbor.node.id)) continue;
      const distance = current.distance + 1;
      found.set(neighbor.node.id, { node: neighbor.node, distance, via: neighbor.edge });
      queue.push({ id: neighbor.node.id, distance });
    }
  }
  return found;
}

function compareImpacts(a: ImpactedGraphNode, b: ImpactedGraphNode): number {
  return (
    a.distance - b.distance ||
    compareStrings(a.node.kind, b.node.kind) ||
    compareStrings(a.node.id, b.node.id)
  );
}

/**
 * Trace changed-file evidence toward dependants. The baseline graph participates
 * so deleted symbols and removed relationships still produce an impact report.
 */
export function analyzeChangeImpact(options: {
  readonly current: EvidenceGraph;
  readonly baseline?: EvidenceGraph;
  readonly changes: GitChangeSet;
  readonly maxDepth?: number;
}): ChangeImpactReport {
  const maxDepth = options.maxDepth ?? 6;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new DocgenError({
      code: 'impact-depth-invalid',
      message: `Impact depth must be a non-negative integer, got '${maxDepth}'.`,
      remedy: 'Pass a whole number such as 4, or omit it to use 6.',
    });
  }

  const files = options.changes.changes.map((change): FileChangeImpact => {
    const currentFiles = new Set([change.file]);
    const baselineFiles = new Set([change.previousFile ?? change.file]);
    const current = impactInGraph(options.current, currentFiles, maxDepth);
    const baseline =
      options.baseline === undefined
        ? new Map<string, Omit<ImpactedGraphNode, 'basis'>>()
        : impactInGraph(options.baseline, baselineFiles, maxDepth);
    const ids = [...new Set([...current.keys(), ...baseline.keys()])].sort(compareStrings);
    const impacted = ids
      .map((id): ImpactedGraphNode | undefined => {
        const live = current.get(id);
        const old = baseline.get(id);
        const selected =
          live === undefined ? old : old === undefined ? live : live.distance <= old.distance ? live : old;
        if (selected === undefined) return undefined;
        return {
          ...selected,
          basis: [
            ...(old === undefined ? [] : ['baseline' as const]),
            ...(live === undefined ? [] : ['current' as const]),
          ],
        };
      })
      .filter((item): item is ImpactedGraphNode => item !== undefined)
      .sort(compareImpacts);
    return { change, impacted };
  });

  return { base: options.changes.base, maxDepth, files };
}
