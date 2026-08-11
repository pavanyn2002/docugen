import { EvidenceGraphBuilder } from './builder.js';
import { EVIDENCE_GRAPH_SCHEMA_VERSION } from './types.js';
import type { EvidenceGraph, GraphEdge, GraphNode, GraphProvenance } from './types.js';
import type { Gap } from '../types/core.js';
import type { FileFingerprintDiff, FileFingerprintManifest } from './fingerprints.js';
import { compareStrings } from '../util/sort.js';
import { serialiseEvidenceGraph } from './serialize.js';

export const GRAPH_PARTITION_SCHEMA_VERSION = 1 as const;
export const GLOBAL_GRAPH_PARTITION = '$global';

export interface GraphPartitionProfile {
  readonly engineVersion: string;
  readonly includeSymbols: boolean;
  readonly configSha256: string;
  readonly symbolAdaptersSha256: string;
}

export interface GraphPartition {
  readonly key: string;
  readonly sourceSha256?: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly gaps: readonly Gap[];
}

export interface GraphPartitionManifest {
  readonly schemaVersion: typeof GRAPH_PARTITION_SCHEMA_VERSION;
  readonly graphSchemaVersion: typeof EVIDENCE_GRAPH_SCHEMA_VERSION;
  readonly engineVersion: string;
  readonly includeSymbols: boolean;
  readonly configSha256: string;
  readonly symbolAdaptersSha256: string;
  readonly partitions: readonly GraphPartition[];
}

export interface IncrementalPartitionResult {
  readonly manifest: GraphPartitionManifest;
  readonly mode: 'full' | 'incremental' | 'fallback';
  readonly invalidated: readonly string[];
  readonly reused: readonly string[];
  /** Success flag; `verification` states whether clean or partition integrity was proven. */
  readonly candidateEquivalent: boolean;
  readonly verification: 'clean-equivalent' | 'partition-integrity';
}

export interface GraphPartitionRebuildPlan {
  readonly mode: 'full' | 'incremental';
  readonly invalidated: readonly string[];
  readonly reused: readonly string[];
}

function keysForProvenance(provenance: GraphProvenance): readonly string[] {
  const files = [...new Set(provenance.evidence.map((ref) => ref.file))].sort(compareStrings);
  return files.length === 0 ? [GLOBAL_GRAPH_PARTITION] : files;
}

function provenanceForKey(provenance: GraphProvenance, key: string): GraphProvenance {
  return {
    ...provenance,
    evidence:
      key === GLOBAL_GRAPH_PARTITION
        ? provenance.evidence
        : provenance.evidence.filter((ref) => ref.file === key),
  };
}

interface MutablePartition {
  key: string;
  sourceSha256?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  gaps: Gap[];
}

/** Split provenance by evidence file so deleting one partition cannot retain stale refs elsewhere. */
export function partitionEvidenceGraph(
  graph: EvidenceGraph,
  fingerprints: FileFingerprintManifest | undefined,
  profile: GraphPartitionProfile,
): GraphPartitionManifest {
  const hashes = new Map((fingerprints?.files ?? []).map((entry) => [entry.file, entry.sha256]));
  const partitions = new Map<string, MutablePartition>();
  const get = (key: string): MutablePartition => {
    let partition = partitions.get(key);
    if (partition === undefined) {
      const sourceSha256 = hashes.get(key);
      partition = {
        key,
        ...(sourceSha256 === undefined ? {} : { sourceSha256 }),
        nodes: [],
        edges: [],
        gaps: [],
      };
      partitions.set(key, partition);
    }
    return partition;
  };

  for (const node of graph.nodes) {
    for (const key of keysForProvenance(node.provenance)) {
      get(key).nodes.push({ ...node, provenance: provenanceForKey(node.provenance, key) });
    }
  }
  for (const edge of graph.edges) {
    for (const key of keysForProvenance(edge.provenance)) {
      get(key).edges.push({ ...edge, provenance: provenanceForKey(edge.provenance, key) });
    }
  }
  for (const gap of graph.gaps) get(gap.source?.file ?? GLOBAL_GRAPH_PARTITION).gaps.push(gap);

  return {
    schemaVersion: GRAPH_PARTITION_SCHEMA_VERSION,
    graphSchemaVersion: EVIDENCE_GRAPH_SCHEMA_VERSION,
    ...profile,
    partitions: [...partitions.values()]
      .sort((a, b) => compareStrings(a.key, b.key))
      .map((partition) => ({
        ...partition,
        nodes: partition.nodes.sort((a, b) => compareStrings(a.id, b.id)),
        edges: partition.edges.sort((a, b) => compareStrings(a.id, b.id)),
        gaps: partition.gaps.sort(
          (a, b) => compareStrings(a.extractor, b.extractor) || compareStrings(a.kind, b.kind),
        ),
      })),
  };
}

/** Merge partitions and run the normal graph validator over the result. */
export function mergeGraphPartitions(manifest: GraphPartitionManifest): EvidenceGraph {
  const builder = new EvidenceGraphBuilder();
  for (const partition of manifest.partitions) {
    for (const node of partition.nodes) builder.addNode(node);
  }
  for (const partition of manifest.partitions) {
    for (const edge of partition.edges) builder.addEdge(edge);
    for (const gap of partition.gaps) builder.addGap(gap);
  }
  return builder.build();
}

function nodeFiles(graph: EvidenceGraph): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, ReadonlySet<string>>();
  for (const node of graph.nodes) {
    const files = new Set(node.provenance.evidence.map((ref) => ref.file));
    if (node.kind === 'file') files.add(node.label);
    result.set(node.id, files);
  }
  return result;
}

/** Files whose assertions depend on facts owned by another file. */
function reverseDependencies(graph: EvidenceGraph): ReadonlyMap<string, ReadonlySet<string>> {
  const filesByNode = nodeFiles(graph);
  const dependants = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const sources = filesByNode.get(edge.from) ?? new Set<string>();
    const targets = filesByNode.get(edge.to) ?? new Set<string>();
    for (const target of targets) {
      for (const source of sources) {
        if (source === target) continue;
        const values = dependants.get(target) ?? new Set<string>();
        values.add(source);
        dependants.set(target, values);
      }
    }
  }
  return dependants;
}

function invalidationClosure(
  changed: ReadonlySet<string>,
  graphs: readonly EvidenceGraph[],
): ReadonlySet<string> {
  const combined = new Map<string, Set<string>>();
  for (const graph of graphs) {
    for (const [target, sources] of reverseDependencies(graph)) {
      const values = combined.get(target) ?? new Set<string>();
      for (const source of sources) values.add(source);
      combined.set(target, values);
    }
  }
  const affected = new Set(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    const target = queue.shift();
    if (target === undefined) continue;
    for (const dependant of combined.get(target) ?? []) {
      if (affected.has(dependant)) continue;
      affected.add(dependant);
      queue.push(dependant);
    }
  }
  affected.add(GLOBAL_GRAPH_PARTITION);
  return affected;
}

/** Decide which prior partitions must be removed before a scoped extraction. */
export function planGraphPartitionRebuild(options: {
  readonly previous?: GraphPartitionManifest;
  readonly changes: FileFingerprintDiff;
  readonly profile: GraphPartitionProfile;
}): GraphPartitionRebuildPlan {
  const profileMatches =
    options.previous?.engineVersion === options.profile.engineVersion &&
    options.previous.includeSymbols === options.profile.includeSymbols &&
    options.previous.configSha256 === options.profile.configSha256 &&
    options.previous.symbolAdaptersSha256 === options.profile.symbolAdaptersSha256;
  if (options.previous === undefined || !profileMatches) {
    return {
      mode: 'full',
      invalidated: options.previous?.partitions.map((partition) => partition.key) ?? [],
      reused: [],
    };
  }

  const previousGraph = mergeGraphPartitions(options.previous);
  const changed = new Set([
    ...options.changes.added,
    ...options.changes.changed,
    ...options.changes.deleted,
  ]);
  const invalidated = invalidationClosure(changed, [previousGraph]);
  return {
    mode: 'incremental',
    invalidated: [...invalidated].sort(compareStrings),
    reused: options.previous.partitions
      .map((partition) => partition.key)
      .filter((key) => !invalidated.has(key))
      .sort(compareStrings),
  };
}

/** Merge only partitions that are safe to seed into a scoped extraction. */
export function mergeReusableGraphPartitions(
  previous: GraphPartitionManifest,
  invalidated: readonly string[],
): EvidenceGraph {
  const removed = new Set(invalidated);
  return mergeGraphPartitions({
    ...previous,
    partitions: previous.partitions.filter((partition) => !removed.has(partition.key)),
  });
}

/**
 * Accept a scoped reconstruction only when every partition promised as reused
 * is byte-identical to its prior value. The merged graph has already passed the
 * normal graph validator; a mismatch tells the caller to perform a clean run.
 */
export function acceptScopedGraphPartitions(options: {
  readonly previous: GraphPartitionManifest;
  readonly graph: EvidenceGraph;
  readonly fingerprints: FileFingerprintManifest;
  readonly invalidated: readonly string[];
  readonly profile: GraphPartitionProfile;
}): IncrementalPartitionResult | undefined {
  const candidate = partitionEvidenceGraph(options.graph, options.fingerprints, options.profile);
  const invalidated = new Set(options.invalidated);
  const previousByKey = new Map(options.previous.partitions.map((partition) => [partition.key, partition]));
  const candidateByKey = new Map(candidate.partitions.map((partition) => [partition.key, partition]));
  const reused: string[] = [];

  for (const [key, previous] of previousByKey) {
    if (invalidated.has(key)) continue;
    const current = candidateByKey.get(key);
    if (current === undefined || JSON.stringify(current) !== JSON.stringify(previous)) return undefined;
    reused.push(key);
  }

  return {
    manifest: candidate,
    mode: 'incremental',
    invalidated: [...invalidated].sort(compareStrings),
    reused: reused.sort(compareStrings),
    // Scoped runs prove partition integrity rather than computing a second,
    // clean graph. Golden equivalence tests cover the stronger invariant.
    candidateEquivalent: true,
    verification: 'partition-integrity',
  };
}

/**
 * Reuse unaffected prior partitions, replace the invalidation closure, and
 * prove the reconstructed graph equals the clean build. A mismatch safely
 * falls back to the clean partition set.
 */
export function updateGraphPartitions(options: {
  readonly previous?: GraphPartitionManifest;
  readonly cleanGraph: EvidenceGraph;
  readonly fingerprints: FileFingerprintManifest;
  readonly changes: FileFingerprintDiff;
  readonly profile: GraphPartitionProfile;
}): IncrementalPartitionResult {
  const clean = partitionEvidenceGraph(options.cleanGraph, options.fingerprints, options.profile);
  const profileMatches =
    options.previous?.engineVersion === options.profile.engineVersion &&
    options.previous.includeSymbols === options.profile.includeSymbols &&
    options.previous.configSha256 === options.profile.configSha256 &&
    options.previous.symbolAdaptersSha256 === options.profile.symbolAdaptersSha256;
  if (options.previous === undefined || !profileMatches) {
    return {
      manifest: clean,
      mode: 'full',
      invalidated: clean.partitions.map((partition) => partition.key),
      reused: [],
      candidateEquivalent: true,
      verification: 'clean-equivalent',
    };
  }

  const previousGraph = mergeGraphPartitions(options.previous);
  const changed = new Set([
    ...options.changes.added,
    ...options.changes.changed,
    ...options.changes.deleted,
  ]);
  const invalidated = invalidationClosure(changed, [previousGraph, options.cleanGraph]);
  const oldByKey = new Map(options.previous.partitions.map((partition) => [partition.key, partition]));
  const cleanByKey = new Map(clean.partitions.map((partition) => [partition.key, partition]));
  const keys = [...new Set([...oldByKey.keys(), ...cleanByKey.keys()])].sort(compareStrings);
  const candidatePartitions: GraphPartition[] = [];
  const reused: string[] = [];
  for (const key of keys) {
    if (!invalidated.has(key)) {
      const old = oldByKey.get(key);
      if (old !== undefined) {
        candidatePartitions.push(old);
        reused.push(key);
        continue;
      }
    }
    const replacement = cleanByKey.get(key);
    if (replacement !== undefined) candidatePartitions.push(replacement);
  }
  const candidate: GraphPartitionManifest = {
    schemaVersion: GRAPH_PARTITION_SCHEMA_VERSION,
    graphSchemaVersion: EVIDENCE_GRAPH_SCHEMA_VERSION,
    ...options.profile,
    partitions: candidatePartitions.sort((a, b) => compareStrings(a.key, b.key)),
  };
  let equivalent = false;
  try {
    equivalent = serialiseEvidenceGraph(mergeGraphPartitions(candidate)) === serialiseEvidenceGraph(options.cleanGraph);
  } catch {
    equivalent = false;
  }
  return {
    manifest: equivalent ? candidate : clean,
    mode: equivalent ? 'incremental' : 'fallback',
    invalidated: [...invalidated].sort(compareStrings),
    reused: equivalent ? reused.sort(compareStrings) : [],
    candidateEquivalent: equivalent,
    verification: 'clean-equivalent',
  };
}
