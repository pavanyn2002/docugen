import picomatch from 'picomatch';
import type { ResolvedConfig } from '../config/schema.js';
import { detectServicePrefix, endpointGroupKey, normalisePath } from '../surface/group.js';
import { assignSlugs } from '../surface/slug.js';
import type { SurfaceKind } from '../surface/types.js';
import { DocgenError } from '../util/errors.js';
import { compareStrings } from '../util/sort.js';
import { EvidenceGraphBuilder } from './builder.js';
import { graphEdgeId, graphNodeId } from './ids.js';
import type { EvidenceGraph, GraphNode, GraphProvenance } from './types.js';

interface SurfaceDraft {
  readonly id: string;
  readonly kind: SurfaceKind;
  readonly title: string;
  readonly origin: 'derived' | 'override';
  readonly members: Set<string>;
}

interface SurfaceOverride {
  readonly id: string;
  readonly kind: SurfaceKind;
  readonly title?: string;
  readonly matches: (file: string) => boolean;
}

export function surfaceNodeId(id: string): string {
  return graphNodeId('surface', id);
}

/**
 * Add the QA-facing surface layer to a complete extracted graph.
 *
 * This derives from graph nodes rather than extractor return values so scoped
 * indexing can rebuild surfaces across both reused and freshly extracted
 * partitions without losing membership.
 */
export function mapSurfacesIntoGraph(
  graph: EvidenceGraph,
  config: ResolvedConfig,
): EvidenceGraph {
  const previousSurfaceIds = new Set(
    graph.nodes.filter((node) => node.kind === 'surface').map((node) => node.id),
  );
  const baseNodes = graph.nodes.filter((node) => node.kind !== 'surface');
  const baseEdges = graph.edges.filter(
    (edge) => !previousSurfaceIds.has(edge.from) && !previousSurfaceIds.has(edge.to),
  );
  const nodeById = new Map(baseNodes.map((node) => [node.id, node]));
  const filesByNode = sourceFiles(baseNodes, baseEdges);
  const overrides: SurfaceOverride[] = config.surfaces.overrides.map((override) => ({
    id: override.id,
    kind: override.kind,
    ...(override.title === undefined ? {} : { title: override.title }),
    matches: picomatch([...override.include], { dot: true }),
  }));
  const drafts = new Map<string, SurfaceDraft>();
  const getDraft = (
    id: string,
    kind: SurfaceKind,
    title: string,
    origin: 'derived' | 'override',
  ): SurfaceDraft => {
    const existing = drafts.get(id);
    if (existing !== undefined) return existing;
    const draft = { id, kind, title, origin, members: new Set<string>() };
    drafts.set(id, draft);
    return draft;
  };
  const overrideFor = (node: GraphNode): SurfaceOverride | undefined => {
    const source = node.provenance.evidence[0]?.file;
    if (source === undefined) return undefined;
    const matches = overrides.filter((override) => override.matches(source));
    if (matches.length > 1) {
      throw new DocgenError({
        code: 'surface-override-ambiguous',
        message: `${source} matches ${matches.length} surface overrides: ${matches.map((item) => item.id).join(', ')}.`,
        remedy: 'Narrow surfaces.overrides include globs so each extracted entity belongs to one surface.',
        file: source,
      });
    }
    return matches[0];
  };
  const add = (node: GraphNode, fallback: { id: string; kind: SurfaceKind; title: string }): void => {
    const override = overrideFor(node);
    const draft = override === undefined
      ? getDraft(fallback.id, fallback.kind, fallback.title, 'derived')
      : getDraft(override.id, override.kind, override.title ?? override.id, 'override');
    draft.members.add(node.id);
  };

  const routes = baseNodes.filter((node) => node.kind === 'route');
  const screens = routes.filter((node) => ['page', 'redirect'].includes(String(node.properties?.['routeKind'])));
  for (const route of screens) {
    const routePath = normalisePath(String(route.properties?.['path'] ?? route.label));
    add(route, { id: `screen:${routePath}`, kind: 'screen', title: routePath });
  }
  for (const route of routes.filter((node) => !screens.includes(node))) {
    const override = overrideFor(route);
    if (override !== undefined) {
      getDraft(override.id, override.kind, override.title ?? override.id, 'override').members.add(route.id);
      continue;
    }
    const routePath = normalisePath(String(route.properties?.['path'] ?? route.label));
    const prefix = routePath === '/' ? '/' : `${routePath}/`;
    for (const screen of screens) {
      const screenPath = normalisePath(String(screen.properties?.['path'] ?? screen.label));
      if (screenPath !== routePath && !screenPath.startsWith(prefix)) continue;
      drafts.get(`screen:${screenPath}`)?.members.add(route.id);
    }
  }

  const endpoints = baseNodes.filter((node) => node.kind === 'endpoint');
  const endpointPaths = endpoints.map((node) => String(node.properties?.['path'] ?? node.label));
  const servicePrefix = detectServicePrefix(endpointPaths, config.surfaces.apiBasePaths);
  for (const endpoint of endpoints) {
    const endpointPath = String(endpoint.properties?.['path'] ?? endpoint.label);
    const group = endpointGroupKey(endpointPath, config.surfaces.apiBasePaths, servicePrefix);
    add(endpoint, { id: `api:${group}`, kind: 'endpoint-group', title: group });
  }
  for (const job of baseNodes.filter((node) => node.kind === 'job')) {
    add(job, { id: `job:${job.label}`, kind: 'job', title: job.label });
  }

  const builder = new EvidenceGraphBuilder();
  for (const node of baseNodes) builder.addNode(node);
  for (const edge of baseEdges) builder.addEdge(edge);
  for (const gap of graph.gaps) builder.addGap(gap);
  const ordered = [...drafts.values()].sort((a, b) => compareStrings(a.id, b.id));
  const slugs = assignSlugs(ordered.map((draft) => draft.id));
  for (const draft of ordered) {
    const members = [...draft.members].sort(compareStrings);
    if (members.length === 0) continue;
    const evidence = uniqueEvidence(
      members.flatMap((id) => [...(filesByNode.get(id) ?? [])]).map((file) => ({ file })),
    );
    const provenance: GraphProvenance = {
      origin: 'extracted',
      evidence,
      certainty: 'high',
    };
    const id = surfaceNodeId(draft.id);
    builder.addNode({
      id,
      kind: 'surface',
      label: draft.title,
      provenance,
      properties: {
        surfaceId: draft.id,
        slug: slugs.get(draft.id) as string,
        surfaceKind: draft.kind,
        origin: draft.origin,
      },
    });
    for (const member of members) {
      const memberNode = nodeById.get(member);
      if (memberNode === undefined) continue;
      builder.addEdge({
        id: graphEdgeId('contains', id, member),
        kind: 'contains',
        from: id,
        to: member,
        provenance: memberNode.provenance,
      });
    }
  }
  return builder.build();
}

function sourceFiles(
  nodes: readonly GraphNode[],
  edges: EvidenceGraph['edges'],
): ReadonlyMap<string, ReadonlySet<string>> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result = new Map<string, Set<string>>();
  for (const node of nodes) {
    result.set(node.id, new Set(node.provenance.evidence.map((ref) => ref.file)));
  }
  for (const edge of edges) {
    const target = byId.get(edge.to);
    if (target?.kind !== 'file') continue;
    result.get(edge.from)?.add(target.label);
  }
  return result;
}

function uniqueEvidence(
  values: readonly { readonly file: string }[],
): readonly { readonly file: string }[] {
  return [...new Map(values.map((value) => [value.file, value])).values()]
    .sort((a, b) => compareStrings(a.file, b.file));
}
