import { DocgenError } from '../util/errors.js';
import { EvidenceGraphBuilder } from '../graph/builder.js';
import { graphEdgeId, graphNodeId } from '../graph/ids.js';
import type { EvidenceGraph, GraphProvenance } from '../graph/types.js';
import { featureNodeId } from '../features/graph.js';
import { planNodeId } from '../plans/graph.js';
import { surfaceNodeId } from '../graph/surfaces.js';
import { triagedRequirementNodeId } from '../requirements/graph.js';
import type { StoredChangeRecord } from './schema.js';

export function changeNodeId(id: string): string {
  return graphNodeId('change', id);
}

function provenance(record: StoredChangeRecord): GraphProvenance {
  return {
    origin: 'human',
    evidence: [{ file: record.sourceFile }],
    actor: record.recordedBy,
    recordedAt: record.recordedAt,
  };
}

export function mapChangesIntoGraph(
  graph: EvidenceGraph,
  changes: readonly StoredChangeRecord[],
): EvidenceGraph {
  const builder = new EvidenceGraphBuilder();
  for (const node of graph.nodes) builder.addNode(node);
  for (const edge of graph.edges) builder.addEdge(edge);
  for (const gap of graph.gaps) builder.addGap(gap);
  const known = new Set(graph.nodes.map((node) => node.id));

  for (const change of changes) {
    const id = changeNodeId(change.id);
    const human = provenance(change);
    builder.addNode({
      id,
      kind: 'change',
      label: change.summary,
      provenance: human,
      properties: {
        changeId: change.id,
        changeKind: change.kind,
        base: change.base,
        featureIds: change.featureIds,
        planIds: change.planIds,
        surfaceIds: change.surfaceIds,
        requirementIds: change.requirementIds,
        testFiles: change.testFiles,
        generatedPages: change.generatedPages,
        files: change.files.length,
        ...(change.headCommit === undefined ? {} : { headCommit: change.headCommit }),
        ...(change.headDate === undefined ? {} : { headDate: change.headDate }),
      },
    });
    for (const feature of change.featureIds) {
      const target = featureNodeId(feature);
      if (!known.has(target)) {
        throw new DocgenError({
          code: 'change-feature-missing',
          message: `Change '${change.id}' refers to missing feature '${feature}'.`,
          remedy: 'Register the feature or correct the immutable change record.',
          file: change.sourceFile,
        });
      }
      builder.addEdge({
        id: graphEdgeId('belongs-to-feature', id, target),
        kind: 'belongs-to-feature',
        from: id,
        to: target,
        provenance: human,
      });
    }
    for (const plan of change.planIds) {
      const target = planNodeId(plan);
      if (!known.has(target)) {
        throw new DocgenError({
          code: 'change-plan-missing',
          message: `Change '${change.id}' refers to missing plan '${plan}'.`,
          remedy: 'Create the plan first or correct the immutable change record.',
          file: change.sourceFile,
        });
      }
      builder.addEdge({
        id: graphEdgeId('governed-by', id, target),
        kind: 'governed-by',
        from: id,
        to: target,
        provenance: human,
      });
    }
    const directlyAffected = [
      ...change.surfaceIds.map((value) => ({ kind: 'surface', value, target: surfaceNodeId(value) })),
      ...change.requirementIds.map((value) => ({ kind: 'requirement', value, target: triagedRequirementNodeId(value) })),
      ...change.testFiles.map((value) => ({ kind: 'test', value, target: graphNodeId('test', value) })),
    ];
    for (const affected of directlyAffected) {
      if (!known.has(affected.target)) {
        throw new DocgenError({
          code: `change-${affected.kind}-missing`,
          message: `Change '${change.id}' refers to missing ${affected.kind} '${affected.value}'.`,
          remedy: 'Restore the linked evidence or correct the immutable change record.',
          file: change.sourceFile,
        });
      }
      builder.addEdge({
        id: graphEdgeId('affected-by-change', affected.target, id),
        kind: 'affected-by-change',
        from: affected.target,
        to: id,
        provenance: human,
      });
    }

    const files = new Set(change.files.flatMap((item) => [item.file, item.previousFile].filter((value): value is string => value !== undefined)));
    for (const node of graph.nodes) {
      const matches =
        (node.kind === 'file' && files.has(node.label)) ||
        node.provenance.evidence.some((ref) => files.has(ref.file));
      if (!matches || node.kind === 'feature' || node.kind === 'plan' || node.kind === 'requirement') continue;
      builder.addEdge({
        id: graphEdgeId('affected-by-change', node.id, id),
        kind: 'affected-by-change',
        from: node.id,
        to: id,
        provenance: human,
      });
    }
  }
  return builder.build();
}
