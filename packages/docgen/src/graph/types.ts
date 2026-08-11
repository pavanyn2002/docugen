import type {
  Certainty,
  ExtractionMethod,
  ExtractorId,
  Gap,
  SourceRef,
} from '../types/core.js';

/** Version of the portable evidence-graph representation. */
export const EVIDENCE_GRAPH_SCHEMA_VERSION = 1 as const;

export const GRAPH_NODE_KINDS = [
  'file',
  'module',
  'package',
  'symbol',
  'route',
  'endpoint',
  'shape',
  'schema',
  'field',
  'job',
  'config',
  'guard',
  'surface',
  'feature',
  'plan',
  'change',
  'requirement',
  'test',
] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

export const GRAPH_EDGE_KINDS = [
  'defined-in',
  'contains',
  'imports',
  'calls',
  'instantiates',
  'references-symbol',
  'extends',
  'implements',
  'implemented-by',
  'wrapped-by',
  'guarded-by',
  'handled-by',
  'accepts',
  'returns',
  'has-field',
  'references',
  'declared-in',
  'read-by',
  'belongs-to-feature',
  'affected-by-change',
  'evidenced-by',
  'confirmed-by',
  'tested-by',
  'supersedes',
  'governed-by',
] as const;
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

export type GraphPropertyValue = string | number | boolean | readonly string[];
export type GraphProperties = Readonly<Record<string, GraphPropertyValue>>;

/**
 * Why a node or edge is allowed to exist.
 *
 * Extraction can accumulate evidence from more than one extractor. Inference
 * and human decisions use the same shape, but must never be mistaken for code
 * facts because `origin` is mandatory.
 */
export interface GraphProvenance {
  readonly origin: 'extracted' | 'inferred' | 'human';
  readonly evidence: readonly SourceRef[];
  readonly extractors?: readonly ExtractorId[];
  readonly extractionMethods?: readonly ExtractionMethod[];
  readonly certainty?: Certainty;
  readonly actor?: string;
  readonly recordedAt?: string;
}

export interface GraphNode {
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly label: string;
  readonly provenance: GraphProvenance;
  readonly properties?: GraphProperties;
}

export interface GraphEdge {
  readonly id: string;
  readonly kind: GraphEdgeKind;
  readonly from: string;
  readonly to: string;
  readonly provenance: GraphProvenance;
  readonly properties?: GraphProperties;
}

/** A deterministic, rebuildable view of what the static lane proved. */
export interface EvidenceGraph {
  readonly schemaVersion: typeof EVIDENCE_GRAPH_SCHEMA_VERSION;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly gaps: readonly Gap[];
}

export interface GraphValidationIssue {
  readonly code:
    | 'duplicate-node'
    | 'duplicate-edge'
    | 'dangling-edge'
    | 'invalid-id'
    | 'invalid-evidence-path';
  readonly message: string;
  readonly subjectId: string;
}
