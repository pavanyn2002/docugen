import path from 'node:path';
import { DocgenError } from '../util/errors.js';
import { compareStrings } from '../util/sort.js';
import type { Gap, SourceRef } from '../types/core.js';
import { EVIDENCE_GRAPH_SCHEMA_VERSION } from './types.js';
import type {
  EvidenceGraph,
  GraphEdge,
  GraphNode,
  GraphProperties,
  GraphProvenance,
  GraphValidationIssue,
} from './types.js';

function compareSourceRefs(a: SourceRef, b: SourceRef): number {
  return (
    compareStrings(a.file, b.file) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0)
  );
}

function mergeEvidence(a: readonly SourceRef[], b: readonly SourceRef[]): readonly SourceRef[] {
  const byKey = new Map<string, SourceRef>();
  for (const ref of [...a, ...b]) {
    byKey.set(`${ref.file}:${ref.line ?? ''}:${ref.column ?? ''}`, ref);
  }
  return [...byKey.values()].sort(compareSourceRefs);
}

function mergeStrings<T extends string>(a: readonly T[] = [], b: readonly T[] = []): readonly T[] {
  return [...new Set([...a, ...b])].sort(compareStrings);
}

function mergeProvenance(a: GraphProvenance, b: GraphProvenance): GraphProvenance {
  if (a.origin !== b.origin) {
    throw new DocgenError({
      code: 'graph-provenance-conflict',
      message: `Cannot merge graph evidence from '${a.origin}' and '${b.origin}'.`,
      remedy: 'Give extracted, inferred, and human assertions separate node or edge ids.',
    });
  }
  if (a.actor !== undefined && b.actor !== undefined && a.actor !== b.actor) {
    throw new DocgenError({
      code: 'graph-actor-conflict',
      message: `Cannot merge graph assertions recorded by '${a.actor}' and '${b.actor}'.`,
      remedy: 'Keep separately attributed human assertions as separate graph entities.',
    });
  }
  if (a.recordedAt !== undefined && b.recordedAt !== undefined && a.recordedAt !== b.recordedAt) {
    throw new DocgenError({
      code: 'graph-recorded-at-conflict',
      message: `Cannot merge graph assertions recorded at '${a.recordedAt}' and '${b.recordedAt}'.`,
      remedy: 'Keep assertions made at different times as separate graph entities.',
    });
  }

  const extractors = mergeStrings(a.extractors, b.extractors);
  const extractionMethods = mergeStrings(a.extractionMethods, b.extractionMethods);
  const certainty = a.certainty === 'low' || b.certainty === 'low' ? 'low' : a.certainty ?? b.certainty;

  return {
    origin: a.origin,
    evidence: mergeEvidence(a.evidence, b.evidence),
    ...(extractors.length === 0 ? {} : { extractors }),
    ...(extractionMethods.length === 0 ? {} : { extractionMethods }),
    ...(certainty === undefined ? {} : { certainty }),
    ...(a.actor === undefined ? (b.actor === undefined ? {} : { actor: b.actor }) : { actor: a.actor }),
    ...(a.recordedAt === undefined
      ? b.recordedAt === undefined
        ? {}
        : { recordedAt: b.recordedAt }
      : { recordedAt: a.recordedAt }),
  };
}

function normaliseProvenance(provenance: GraphProvenance): GraphProvenance {
  return {
    origin: provenance.origin,
    evidence: [...provenance.evidence].sort(compareSourceRefs),
    ...(provenance.extractors === undefined ? {} : { extractors: [...provenance.extractors] }),
    ...(provenance.extractionMethods === undefined
      ? {}
      : { extractionMethods: [...provenance.extractionMethods] }),
    ...(provenance.certainty === undefined ? {} : { certainty: provenance.certainty }),
    ...(provenance.actor === undefined ? {} : { actor: provenance.actor }),
    ...(provenance.recordedAt === undefined ? {} : { recordedAt: provenance.recordedAt }),
  };
}

function normaliseProperties(properties: GraphProperties | undefined): GraphProperties | undefined {
  if (properties === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(properties)
      .sort(([a], [b]) => compareStrings(a, b))
      // Array order can be semantic (middleware order, route parameters), so
      // preserve it. Extractors already guarantee deterministic ordering.
      .map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
  );
}

function propertiesEqual(a: GraphProperties | undefined, b: GraphProperties | undefined): boolean {
  return JSON.stringify(normaliseProperties(a)) === JSON.stringify(normaliseProperties(b));
}

function invalidId(id: string): boolean {
  return id.trim().length === 0 || /[\r\n\u0000]/.test(id);
}

function invalidEvidencePath(file: string): boolean {
  return file.includes('\\') || path.posix.isAbsolute(file) || /^[a-zA-Z]:\//.test(file);
}

export function validateEvidenceGraph(graph: EvidenceGraph): readonly GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  for (const node of graph.nodes) {
    if (invalidId(node.id)) {
      issues.push({ code: 'invalid-id', message: `Invalid graph node id '${node.id}'.`, subjectId: node.id });
    }
    if (nodeIds.has(node.id)) {
      issues.push({ code: 'duplicate-node', message: `Duplicate graph node '${node.id}'.`, subjectId: node.id });
    }
    nodeIds.add(node.id);
    for (const ref of node.provenance.evidence) {
      if (invalidEvidencePath(ref.file)) {
        issues.push({
          code: 'invalid-evidence-path',
          message: `Evidence path '${ref.file}' is not repo-relative POSIX.`,
          subjectId: node.id,
        });
      }
    }
  }

  for (const edge of graph.edges) {
    if (invalidId(edge.id)) {
      issues.push({ code: 'invalid-id', message: `Invalid graph edge id '${edge.id}'.`, subjectId: edge.id });
    }
    if (edgeIds.has(edge.id)) {
      issues.push({ code: 'duplicate-edge', message: `Duplicate graph edge '${edge.id}'.`, subjectId: edge.id });
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      issues.push({
        code: 'dangling-edge',
        message: `Graph edge '${edge.id}' references a node that does not exist.`,
        subjectId: edge.id,
      });
    }
    for (const ref of edge.provenance.evidence) {
      if (invalidEvidencePath(ref.file)) {
        issues.push({
          code: 'invalid-evidence-path',
          message: `Evidence path '${ref.file}' is not repo-relative POSIX.`,
          subjectId: edge.id,
        });
      }
    }
  }

  return issues.sort(
    (a, b) => compareStrings(a.subjectId, b.subjectId) || compareStrings(a.code, b.code),
  );
}

export class EvidenceGraphBuilder {
  readonly #nodes = new Map<string, GraphNode>();
  readonly #edges = new Map<string, GraphEdge>();
  readonly #gaps: Gap[] = [];

  addNode(node: GraphNode): void {
    const { properties, ...rest } = node;
    const normalised: GraphNode = {
      ...rest,
      provenance: normaliseProvenance(node.provenance),
      ...(properties === undefined ? {} : { properties: normaliseProperties(properties) as GraphProperties }),
    };
    const previous = this.#nodes.get(node.id);
    if (previous === undefined) {
      this.#nodes.set(node.id, normalised);
      return;
    }
    if (previous.kind !== node.kind || previous.label !== node.label || !propertiesEqual(previous.properties, node.properties)) {
      throw new DocgenError({
        code: 'graph-node-conflict',
        message: `Graph node '${node.id}' was defined with conflicting content.`,
        remedy: 'Use a stable id that identifies exactly one semantic entity.',
      });
    }
    this.#nodes.set(node.id, {
      ...previous,
      provenance: mergeProvenance(previous.provenance, node.provenance),
    });
  }

  addEdge(edge: GraphEdge): void {
    const { properties, ...rest } = edge;
    const normalised: GraphEdge = {
      ...rest,
      provenance: normaliseProvenance(edge.provenance),
      ...(properties === undefined ? {} : { properties: normaliseProperties(properties) as GraphProperties }),
    };
    const previous = this.#edges.get(edge.id);
    if (previous === undefined) {
      this.#edges.set(edge.id, normalised);
      return;
    }
    if (
      previous.kind !== edge.kind ||
      previous.from !== edge.from ||
      previous.to !== edge.to ||
      !propertiesEqual(previous.properties, edge.properties)
    ) {
      throw new DocgenError({
        code: 'graph-edge-conflict',
        message: `Graph edge '${edge.id}' was defined with conflicting content.`,
        remedy: 'Use an edge discriminator when two relationships need separate identities.',
      });
    }
    this.#edges.set(edge.id, {
      ...previous,
      provenance: mergeProvenance(previous.provenance, edge.provenance),
    });
  }

  addGap(gap: Gap): void {
    this.#gaps.push(gap);
  }

  hasNode(id: string): boolean {
    return this.#nodes.has(id);
  }

  build(): EvidenceGraph {
    const graph: EvidenceGraph = {
      schemaVersion: EVIDENCE_GRAPH_SCHEMA_VERSION,
      nodes: [...this.#nodes.values()].sort((a, b) => compareStrings(a.id, b.id)),
      edges: [...this.#edges.values()].sort((a, b) => compareStrings(a.id, b.id)),
      gaps: [...this.#gaps].sort(
        (a, b) => compareStrings(a.extractor, b.extractor) || compareStrings(a.kind, b.kind) || compareStrings(a.message, b.message),
      ),
    };
    const issues = validateEvidenceGraph(graph);
    if (issues.length > 0) {
      throw new DocgenError({
        code: 'graph-invalid',
        message: `The evidence graph is invalid: ${issues[0]?.message ?? 'unknown validation failure'}`,
        remedy: 'Fix the extractor-to-graph adapter that produced the invalid node or edge.',
      });
    }
    return graph;
  }
}
