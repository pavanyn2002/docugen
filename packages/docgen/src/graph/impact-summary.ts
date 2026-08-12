import path from 'node:path';
import type { ChangeImpactReport, ImpactedGraphNode } from './impact.js';
import type { GraphNode } from './types.js';
import { compareStrings } from '../util/sort.js';
import { toPosix } from '../util/paths.js';

export interface ChangeSurfaceSummary {
  readonly surfaceIds: readonly string[];
  readonly featureIds: readonly string[];
  readonly planIds: readonly string[];
  readonly requirementIds: readonly string[];
  readonly testFiles: readonly string[];
  readonly generatedPages: readonly string[];
}

/** A stable QA/documentation projection shared by impact, changes, and handoffs. */
export function summarizeChangeSurfaces(args: {
  readonly report: ChangeImpactReport;
  readonly outDir: string;
  /** Recording a governed change itself makes the changelog a required page. */
  readonly includeChangelog?: boolean;
}): ChangeSurfaceSummary {
  const impacted = uniqueNodes(args.report.files.flatMap((file) => file.impacted));
  const surfaceIds = propertyValues(impacted, 'surface', 'surfaceId');
  const featureIds = propertyValues(impacted, 'feature', 'featureId');
  const planIds = propertyValues(impacted, 'plan', 'planId');
  const requirementIds = impacted
    .filter((node) => node.kind === 'requirement' && typeof node.properties?.['surfaceId'] === 'string')
    .map((node) => node.properties?.['requirementId'])
    .filter((value): value is string => typeof value === 'string')
    .filter(unique)
    .sort(compareStrings);
  const testFiles = impacted
    .filter((node) => node.kind === 'test')
    .map((node) => node.label)
    .filter(unique)
    .sort(compareStrings);
  const generatedPages = pagesFor({
    nodes: impacted,
    outDir: toPosix(args.outDir).replace(/\/+$/, ''),
    includeChangelog: args.includeChangelog === true,
  });
  return { surfaceIds, featureIds, planIds, requirementIds, testFiles, generatedPages };
}

function uniqueNodes(impacts: readonly ImpactedGraphNode[]): readonly GraphNode[] {
  return [...new Map(impacts.map((impact) => [impact.node.id, impact.node])).values()]
    .sort((a, b) => compareStrings(a.id, b.id));
}

function propertyValues(
  nodes: readonly GraphNode[],
  kind: GraphNode['kind'],
  property: string,
): readonly string[] {
  return nodes
    .filter((node) => node.kind === kind)
    .map((node) => node.properties?.[property])
    .filter((value): value is string => typeof value === 'string')
    .filter(unique)
    .sort(compareStrings);
}

function pagesFor(args: {
  readonly nodes: readonly GraphNode[];
  readonly outDir: string;
  readonly includeChangelog: boolean;
}): readonly string[] {
  const pages = new Set<string>();
  const add = (file: string): void => { pages.add(path.posix.join(args.outDir, file)); };
  if (args.nodes.length > 0) add('README.md');
  const kinds = new Set(args.nodes.map((node) => node.kind));
  const surfaces = args.nodes.filter((node) => node.kind === 'surface');
  const surfaceKinds = new Set(surfaces.map((node) => node.properties?.['surfaceKind']));
  if (kinds.has('route') || surfaceKinds.has('screen')) {
    add('routes.md');
    add('diagrams/sitemap.mmd');
  }
  if (kinds.has('endpoint') || kinds.has('shape') || surfaceKinds.has('endpoint-group')) add('api.md');
  if (kinds.has('job') || surfaceKinds.has('job')) add('jobs.md');
  if (kinds.has('schema') || kinds.has('field')) {
    add('schema.md');
    add('diagrams/erd.mmd');
  }
  if (kinds.has('config')) {
    add('config.md');
    add('diagrams/integrations.mmd');
  }
  if (kinds.has('module') || kinds.has('package')) {
    add('diagrams/modules.mmd');
    add('diagrams/integrations.mmd');
  }
  const features = propertyValues(args.nodes, 'feature', 'featureId');
  if (features.length > 0) add('features.md');
  for (const feature of features) add(`features/${feature}.md`);
  for (const plan of propertyValues(args.nodes, 'plan', 'planId')) add(`plans/${plan}.md`);
  const hasTriagedRequirement = args.nodes.some(
    (node) => node.kind === 'requirement' && typeof node.properties?.['surfaceId'] === 'string',
  );
  if (hasTriagedRequirement || kinds.has('test')) {
    add('requirements.md');
    add('test-cases.md');
    add('traceability.md');
  }
  if (args.includeChangelog) add('changelog.md');
  return [...pages].sort(compareStrings);
}

function unique(value: string, index: number, values: readonly string[]): boolean {
  return values.indexOf(value) === index;
}
