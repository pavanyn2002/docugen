import { REQUIREMENTS_DIR } from '../config/paths.js';
import { EvidenceGraphBuilder } from '../graph/builder.js';
import { graphEdgeId, graphNodeId } from '../graph/ids.js';
import { surfaceNodeId } from '../graph/surfaces.js';
import type { EvidenceGraph, GraphProvenance } from '../graph/types.js';
import type { TestReference } from '../trace/scan.js';
import { compareStrings } from '../util/sort.js';
import type { SurfaceRequirements } from './types.js';

export function triagedRequirementNodeId(id: string): string {
  return graphNodeId('requirement', id);
}

/** Add attributed requirements and explicit test citations to the evidence graph. */
export function mapRequirementsIntoGraph(args: {
  readonly graph: EvidenceGraph;
  readonly requirements: ReadonlyMap<string, SurfaceRequirements>;
  readonly testReferences: readonly TestReference[];
}): EvidenceGraph {
  const builder = new EvidenceGraphBuilder();
  for (const node of args.graph.nodes) builder.addNode(node);
  for (const edge of args.graph.edges) builder.addEdge(edge);
  for (const gap of args.graph.gaps) builder.addGap(gap);
  const knownNodes = new Set(args.graph.nodes.map((node) => node.id));
  const requirementNodes = new Map<string, string>();

  for (const surface of [...args.requirements.values()].sort((a, b) => compareStrings(a.surfaceId, b.surfaceId))) {
    const target = surfaceNodeId(surface.surfaceId);
    for (const requirement of surface.requirements) {
      const id = triagedRequirementNodeId(requirement.id);
      const sourceFile = surface.sourceFile ?? `${REQUIREMENTS_DIR}/${surface.slug}.yaml`;
      const provenance: GraphProvenance = {
        origin: 'human',
        evidence: [{ file: sourceFile }],
        actor: requirement.recordedBy,
        recordedAt: requirement.recordedAt,
      };
      builder.addNode({
        id,
        kind: 'requirement',
        label: requirement.statement,
        provenance,
        properties: {
          requirementId: requirement.id,
          requirementKind: requirement.kind,
          status: requirement.status,
          surfaceId: requirement.surfaceId,
          questionId: requirement.questionId,
        },
      });
      requirementNodes.set(requirement.id, id);
      if (knownNodes.has(target)) {
        builder.addEdge({
          id: graphEdgeId('belongs-to-surface', id, target),
          kind: 'belongs-to-surface',
          from: id,
          to: target,
          provenance,
        });
      } else {
        builder.addGap({
          extractor: 'surface',
          kind: 'requirement-surface-missing',
          message: `Requirement '${requirement.id}' refers to absent surface '${requirement.surfaceId}'.`,
          source: { file: sourceFile },
        });
      }
    }
  }

  const referencesByFile = new Map<string, TestReference[]>();
  for (const reference of args.testReferences) {
    const values = referencesByFile.get(reference.file) ?? [];
    values.push(reference);
    referencesByFile.set(reference.file, values);
  }
  for (const [file, references] of [...referencesByFile].sort(([a], [b]) => compareStrings(a, b))) {
    const ids = [...new Set(references.map((reference) => reference.id))].sort(compareStrings);
    const testId = graphNodeId('test', file);
    builder.addNode({
      id: testId,
      kind: 'test',
      label: file,
      provenance: {
        origin: 'extracted',
        evidence: references.map((reference) => ({ file, line: reference.line })),
        extractionMethods: ['regex'],
        certainty: 'high',
      },
      properties: { requirementIds: ids },
    });
    for (const reference of references) {
      const requirementId = requirementNodes.get(reference.id);
      if (requirementId === undefined) {
        builder.addGap({
          extractor: 'surface',
          kind: 'test-requirement-missing',
          message: `Test citation '${reference.id}' has no human-owned requirement record.`,
          source: { file, line: reference.line },
        });
        continue;
      }
      builder.addEdge({
        id: graphEdgeId('tested-by', requirementId, testId),
        kind: 'tested-by',
        from: requirementId,
        to: testId,
        provenance: {
          origin: 'extracted',
          evidence: [{ file, line: reference.line }],
          extractionMethods: ['regex'],
          certainty: 'high',
        },
      });
    }
  }
  return builder.build();
}
