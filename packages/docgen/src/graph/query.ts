import { DocgenError } from '../util/errors.js';
import { compareStrings } from '../util/sort.js';
import { validateEvidenceGraph } from './builder.js';
import type {
  EvidenceGraph,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
} from './types.js';

export type GraphDirection = 'incoming' | 'outgoing' | 'both';

export interface GraphNeighbor {
  readonly node: GraphNode;
  readonly edge: GraphEdge;
  readonly direction: 'incoming' | 'outgoing';
}

export interface GraphSearchOptions {
  readonly text?: string;
  readonly kinds?: readonly GraphNodeKind[];
  readonly limit?: number;
}

export interface GraphTraversalOptions {
  readonly direction?: GraphDirection;
  readonly edgeKinds?: readonly GraphEdgeKind[];
}

export interface GraphPathOptions extends GraphTraversalOptions {
  /** Maximum number of relationships to cross. Defaults to 12. */
  readonly maxDepth?: number;
}

export interface GraphPath {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface GraphExplanation {
  readonly node: GraphNode;
  readonly incoming: readonly GraphNeighbor[];
  readonly outgoing: readonly GraphNeighbor[];
}

function compareNeighbors(a: GraphNeighbor, b: GraphNeighbor): number {
  return (
    compareStrings(a.node.id, b.node.id) ||
    compareStrings(a.edge.kind, b.edge.kind) ||
    compareStrings(a.edge.id, b.edge.id)
  );
}

/** Indexed, deterministic queries over an immutable evidence graph. */
export class EvidenceGraphIndex {
  readonly #nodes = new Map<string, GraphNode>();
  readonly #incoming = new Map<string, GraphEdge[]>();
  readonly #outgoing = new Map<string, GraphEdge[]>();

  constructor(readonly graph: EvidenceGraph) {
    const issues = validateEvidenceGraph(graph);
    if (issues.length > 0) {
      throw new DocgenError({
        code: 'graph-query-invalid',
        message: `Cannot query an invalid evidence graph: ${issues[0]?.message ?? 'unknown validation failure'}`,
        remedy: 'Rebuild the index from source or fix the graph producer.',
      });
    }

    for (const node of graph.nodes) this.#nodes.set(node.id, node);
    for (const edge of graph.edges) {
      const outgoing = this.#outgoing.get(edge.from) ?? [];
      outgoing.push(edge);
      this.#outgoing.set(edge.from, outgoing);

      const incoming = this.#incoming.get(edge.to) ?? [];
      incoming.push(edge);
      this.#incoming.set(edge.to, incoming);
    }
    for (const edges of this.#incoming.values()) edges.sort((a, b) => compareStrings(a.id, b.id));
    for (const edges of this.#outgoing.values()) edges.sort((a, b) => compareStrings(a.id, b.id));
  }

  getNode(id: string): GraphNode | undefined {
    return this.#nodes.get(id);
  }

  requireNode(id: string): GraphNode {
    const node = this.getNode(id);
    if (node !== undefined) return node;
    throw new DocgenError({
      code: 'graph-node-not-found',
      message: `Graph node '${id}' does not exist.`,
      remedy: 'Search the graph for the current node id, or rebuild an out-of-date index.',
    });
  }

  search(options: GraphSearchOptions = {}): readonly GraphNode[] {
    const needle = options.text?.trim().toLowerCase();
    const kinds = options.kinds === undefined ? undefined : new Set(options.kinds);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new DocgenError({
        code: 'graph-query-limit-invalid',
        message: `Graph search limit must be a non-negative integer, got '${limit}'.`,
        remedy: 'Pass a whole number such as 20, or omit the limit to use 50.',
      });
    }

    return this.graph.nodes
      .filter((node) => kinds === undefined || kinds.has(node.kind))
      .filter(
        (node) =>
          needle === undefined ||
          needle.length === 0 ||
          node.id.toLowerCase().includes(needle) ||
          node.label.toLowerCase().includes(needle),
      )
      .slice(0, limit);
  }

  neighbors(id: string, options: GraphTraversalOptions = {}): readonly GraphNeighbor[] {
    this.requireNode(id);
    const direction = options.direction ?? 'both';
    const kinds = options.edgeKinds === undefined ? undefined : new Set(options.edgeKinds);
    const found: GraphNeighbor[] = [];

    if (direction === 'incoming' || direction === 'both') {
      for (const edge of this.#incoming.get(id) ?? []) {
        if (kinds !== undefined && !kinds.has(edge.kind)) continue;
        found.push({ node: this.requireNode(edge.from), edge, direction: 'incoming' });
      }
    }
    if (direction === 'outgoing' || direction === 'both') {
      for (const edge of this.#outgoing.get(id) ?? []) {
        if (kinds !== undefined && !kinds.has(edge.kind)) continue;
        found.push({ node: this.requireNode(edge.to), edge, direction: 'outgoing' });
      }
    }

    return found.sort(compareNeighbors);
  }

  explain(id: string): GraphExplanation {
    return {
      node: this.requireNode(id),
      incoming: this.neighbors(id, { direction: 'incoming' }),
      outgoing: this.neighbors(id, { direction: 'outgoing' }),
    };
  }

  /** Deterministic breadth-first search, returning the shortest path. */
  findPath(from: string, to: string, options: GraphPathOptions = {}): GraphPath | undefined {
    const start = this.requireNode(from);
    const target = this.requireNode(to);
    if (from === to) return { nodes: [start], edges: [] };

    const maxDepth = options.maxDepth ?? 12;
    if (!Number.isInteger(maxDepth) || maxDepth < 1) {
      throw new DocgenError({
        code: 'graph-query-depth-invalid',
        message: `Graph path depth must be a positive integer, got '${maxDepth}'.`,
        remedy: 'Pass a whole number greater than zero, or omit it to use 12.',
      });
    }

    interface QueueItem {
      readonly nodeId: string;
      readonly nodeIds: readonly string[];
      readonly edges: readonly GraphEdge[];
    }

    const queue: QueueItem[] = [{ nodeId: start.id, nodeIds: [start.id], edges: [] }];
    const visited = new Set<string>([start.id]);

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || current.edges.length >= maxDepth) continue;

      for (const neighbor of this.neighbors(current.nodeId, options)) {
        if (visited.has(neighbor.node.id)) continue;
        const nodeIds = [...current.nodeIds, neighbor.node.id];
        const edges = [...current.edges, neighbor.edge];
        if (neighbor.node.id === target.id) {
          return { nodes: nodeIds.map((id) => this.requireNode(id)), edges };
        }
        visited.add(neighbor.node.id);
        queue.push({ nodeId: neighbor.node.id, nodeIds, edges });
      }
    }

    return undefined;
  }
}
