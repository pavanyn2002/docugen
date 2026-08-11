import { DocgenError } from '../util/errors.js';
import { EvidenceGraphBuilder } from '../graph/builder.js';
import { graphEdgeId, graphNodeId } from '../graph/ids.js';
import type { EvidenceGraph, GraphProvenance } from '../graph/types.js';
import { featureNodeId } from '../features/graph.js';
import type { StoredPlanRecord } from './schema.js';

function planProvenance(plan: StoredPlanRecord): GraphProvenance {
  return {
    origin: 'human',
    evidence: [{ file: plan.sourceFile }],
    actor: plan.recordedBy,
    recordedAt: plan.recordedAt,
  };
}

export function planNodeId(id: string): string {
  return graphNodeId('plan', id);
}

export function mapPlansIntoGraph(
  graph: EvidenceGraph,
  plans: readonly StoredPlanRecord[],
): EvidenceGraph {
  const builder = new EvidenceGraphBuilder();
  for (const node of graph.nodes) builder.addNode(node);
  for (const edge of graph.edges) builder.addEdge(edge);
  for (const gap of graph.gaps) builder.addGap(gap);
  const knownNodes = new Set(graph.nodes.map((node) => node.id));

  for (const plan of plans) {
    const featureId = featureNodeId(plan.featureId);
    if (!knownNodes.has(featureId)) {
      throw new DocgenError({
        code: 'plan-feature-missing',
        message: `Plan '${plan.id}' refers to feature '${plan.featureId}', which is not registered.`,
        remedy: 'Register the stable feature first, or correct the plan featureId.',
        file: plan.sourceFile,
      });
    }
    const id = planNodeId(plan.id);
    const provenance = planProvenance(plan);
    builder.addNode({
      id,
      kind: 'plan',
      label: plan.title,
      provenance,
      properties: {
        planId: plan.id,
        featureId: plan.featureId,
        status: plan.status,
        summary: plan.summary,
        acceptanceCriteria: plan.acceptanceCriteria.length,
        risks: plan.risks.length,
      },
    });
    builder.addEdge({
      id: graphEdgeId('belongs-to-feature', id, featureId),
      kind: 'belongs-to-feature',
      from: id,
      to: featureId,
      provenance,
    });
    for (const criterion of plan.acceptanceCriteria) {
      const requirementId = graphNodeId('requirement', `${plan.id}:${criterion.id}`);
      builder.addNode({
        id: requirementId,
        kind: 'requirement',
        label: criterion.text,
        provenance,
        properties: { requirementId: criterion.id, planId: plan.id, featureId: plan.featureId },
      });
      builder.addEdge({
        id: graphEdgeId('contains', id, requirementId),
        kind: 'contains',
        from: id,
        to: requirementId,
        provenance,
      });
      builder.addEdge({
        id: graphEdgeId('belongs-to-feature', requirementId, featureId),
        kind: 'belongs-to-feature',
        from: requirementId,
        to: featureId,
        provenance,
      });
    }
  }
  return builder.build();
}
