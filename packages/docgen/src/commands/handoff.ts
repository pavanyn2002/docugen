import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { deriveFeatureCommitHistory } from '../features/history.js';
import { loadFeatureRecords } from '../features/store.js';
import { analyzeChangeImpact } from '../graph/impact.js';
import { DEFAULT_GRAPH_INDEX, readEvidenceGraphIfExists } from '../graph/store.js';
import type { GraphNodeKind } from '../graph/types.js';
import { renderTesterHandoff } from '../handoff/render.js';
import { loadPlanRecords } from '../plans/store.js';
import { runExtraction } from '../pipeline.js';
import { colors } from '../util/colors.js';
import { DocgenError } from '../util/errors.js';
import { filterGitChanges, resolveCommitInfo, resolveGitChanges } from '../util/git.js';
import type { Logger } from '../util/logger.js';
import { compareStrings } from '../util/sort.js';
import { summarizeChangeSurfaces } from '../graph/impact-summary.js';
import { loadRequirements } from '../requirements/store.js';
import { scanTestReferences } from '../trace/scan.js';
import { writeFileAtomically } from '../util/atomic.js';

// Kept outside the renderer-owned output directory: `docgen sync` deliberately
// deletes unknown files there, while a branch handoff has a different lifecycle.
export const DEFAULT_HANDOFF_FILE = 'docs/handoffs/tester-handoff.md';

export interface HandoffCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  readonly base?: string;
  readonly out?: string;
  readonly maxDepth?: number;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly logger: Logger;
}

function resolveOutput(root: string, requested?: string): string {
  const absolute = path.resolve(root, requested ?? DEFAULT_HANDOFF_FILE);
  const relative = path.relative(path.resolve(root), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new DocgenError({
      code: 'handoff-outside-root',
      message: `Tester handoff must stay inside the target repository: ${absolute}.`,
      remedy: `Use a repo-relative path such as '${DEFAULT_HANDOFF_FILE}'.`,
      file: absolute,
    });
  }
  return absolute;
}

const SURFACE_KINDS = new Set<GraphNodeKind>(['route', 'endpoint', 'job', 'schema', 'config', 'surface']);

export async function runHandoffCommand(options: HandoffCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const changes = filterGitChanges(
    await resolveGitChanges(config.root, options.base ?? 'HEAD'),
    config.effectiveExclude,
  );
  const [run, baseline, head, featureRecords, planRecords, requirements, testReferences] = await Promise.all([
    runExtraction({ config, logger: options.logger, includeSymbols: true }),
    readEvidenceGraphIfExists(path.join(config.root, DEFAULT_GRAPH_INDEX)),
    resolveCommitInfo(config.root),
    loadFeatureRecords(config.root),
    loadPlanRecords(config.root),
    loadRequirements(config.root),
    scanTestReferences({ root: config.root, globs: config.trace.include, exclude: config.effectiveExclude }),
  ]);
  const impact = analyzeChangeImpact({
    current: run.graph,
    ...(baseline === undefined ? {} : { baseline }),
    changes,
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
  });
  const impacted = impact.files.flatMap((file) => file.impacted.map((item) => item.node));
  const surfaceSummary = summarizeChangeSurfaces({ report: impact, outDir: config.outDir });
  const featureIds = new Set(
    impacted
      .filter((node) => node.kind === 'feature')
      .map((node) => node.properties?.['featureId'])
      .filter((value): value is string => typeof value === 'string'),
  );
  const affectedFeatures = featureRecords.filter((record) => featureIds.has(record.id));
  const features = [];
  for (const record of affectedFeatures) {
    const history = await deriveFeatureCommitHistory({ root: config.root, graph: run.graph, record });
    features.push({
      record,
      ...(history === undefined ? {} : { history }),
    });
  }
  const entitiesById = new Map(
    impacted.filter((node) => SURFACE_KINDS.has(node.kind)).map((node) => [node.id, node]),
  );
  const data = {
    base: changes.base,
    ...(head === undefined ? {} : { head }),
    baselineUsed: baseline !== undefined,
    changes: changes.changes,
    features,
    plans: planRecords.filter(
      (plan) =>
        featureIds.has(plan.featureId) &&
        (plan.status === 'approved' || plan.status === 'in-progress' || plan.status === 'completed'),
    ),
    impactedEntities: [...entitiesById.values()].sort(
      (a, b) => compareStrings(a.kind, b.kind) || compareStrings(a.id, b.id),
    ),
    affectedRequirements: [...requirements.values()]
      .flatMap((surface) => surface.requirements)
      .filter((requirement) => surfaceSummary.requirementIds.includes(requirement.id)),
    affectedTests: testReferences.filter(
      (reference) =>
        surfaceSummary.testFiles.includes(reference.file) &&
        surfaceSummary.requirementIds.includes(reference.id),
    ),
    generatedPages: surfaceSummary.generatedPages,
  };
  const contents = renderTesterHandoff(data);
  const file = resolveOutput(config.root, options.out);

  if (options.dryRun !== true) {
    try {
      await writeFileAtomically(file, contents);
    } catch (cause) {
      throw new DocgenError({
        code: 'handoff-write-failed',
        message: `Could not write tester handoff: ${file}.`,
        remedy: 'Check directory permissions and retry.',
        file,
        cause,
      });
    }
  }

  const result = {
    dryRun: options.dryRun === true,
    file,
    bytes: Buffer.byteLength(contents),
    changedFiles: changes.changes.length,
    affectedFeatures: features.length,
    affectedEntities: data.impactedEntities.length,
    plans: data.plans.length,
    requirements: data.affectedRequirements.length,
    tests: data.affectedTests.length,
    surfaceIds: surfaceSummary.surfaceIds,
    requirementIds: surfaceSummary.requirementIds,
    testFiles: surfaceSummary.testFiles,
    generatedPages: data.generatedPages,
  };
  if (options.json === true) {
    options.logger.output(JSON.stringify(result, null, 2));
    return;
  }
  options.logger.heading(options.dryRun === true ? 'Tester handoff (dry run)' : 'Tester handoff');
  options.logger.info(`  changed files  ${result.changedFiles}`);
  options.logger.info(`  features       ${result.affectedFeatures}`);
  options.logger.info(`  surfaces       ${result.affectedEntities}`);
  options.logger.info(`  plans          ${result.plans}`);
  options.logger.info(`  requirements   ${result.requirements}`);
  options.logger.info(`  tests          ${result.tests}`);
  options.logger.info(`  pages          ${result.generatedPages.length}`);
  options.logger.info(`  ${options.dryRun === true ? colors().dim(`would write ${file}`) : `written        ${file}`}`);
}
