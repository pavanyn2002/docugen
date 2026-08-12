import { changeRecordSchema, CHANGE_KINDS, CHANGE_RECORD_SCHEMA_VERSION } from '../changes/schema.js';
import type { ChangeKind } from '../changes/schema.js';
import { writeNewChangeRecord } from '../changes/store.js';
import { loadConfig } from '../config/load.js';
import { findFeatureRecord } from '../features/graph.js';
import { loadFeatureRecords } from '../features/store.js';
import { loadPlanRecords } from '../plans/store.js';
import { analyzeChangeImpact } from '../graph/impact.js';
import { summarizeChangeSurfaces } from '../graph/impact-summary.js';
import { DEFAULT_GRAPH_INDEX, readEvidenceGraphIfExists } from '../graph/store.js';
import { runExtraction } from '../pipeline.js';
import path from 'node:path';
import { DocgenError } from '../util/errors.js';
import {
  filterGitChanges,
  resolveCommitInfo,
  resolveGitChanges,
  resolveGitUserEmail,
} from '../util/git.js';
import type { Logger } from '../util/logger.js';

export interface ChangeRecordCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  readonly id: string;
  readonly summary: string;
  readonly features: string;
  readonly plans?: string;
  readonly kind?: string;
  readonly base?: string;
  readonly recordedBy?: string;
  readonly recordedAt?: string;
  readonly json?: boolean;
  readonly logger: Logger;
}

function list(value: string | undefined): readonly string[] {
  return [...new Set((value ?? '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function changeKind(value: string | undefined): ChangeKind {
  const resolved = value ?? 'feature';
  const kind = CHANGE_KINDS.find((candidate) => candidate === resolved);
  if (kind !== undefined) return kind;
  throw new DocgenError({
    code: 'change-kind-invalid',
    message: `Unknown change kind '${resolved}'.`,
    remedy: `Valid values are: ${CHANGE_KINDS.join(', ')}.`,
  });
}

/** Snapshot an attributed, immutable change from the current Git comparison. */
export async function runChangeRecordCommand(options: ChangeRecordCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const [features, plans, changes, head, run, baseline] = await Promise.all([
    loadFeatureRecords(config.root),
    loadPlanRecords(config.root),
    resolveGitChanges(config.root, options.base ?? 'HEAD'),
    resolveCommitInfo(config.root),
    runExtraction({ config, logger: options.logger, includeSymbols: true }),
    readEvidenceGraphIfExists(path.join(config.root, DEFAULT_GRAPH_INDEX)),
  ]);
  const scopedChanges = filterGitChanges(changes, config.effectiveExclude);
  if (scopedChanges.changes.length === 0) {
    throw new DocgenError({
      code: 'change-files-empty',
      message: `No relevant Git changes were found relative to '${scopedChanges.base}'.`,
      remedy: 'Change code first, or choose the branch base that contains the pre-change state.',
    });
  }
  const featureIds = new Set<string>();
  for (const requested of list(options.features)) {
    const feature = findFeatureRecord(features, requested);
    if (feature === undefined) {
      throw new DocgenError({
        code: 'change-feature-not-found',
        message: `Feature '${requested}' is not registered.`,
        remedy: 'Register it with `docgen feature add`, or use an existing id or alias.',
      });
    }
    featureIds.add(feature.id);
  }
  const planIds: string[] = [];
  for (const requested of list(options.plans)) {
    const plan = plans.find((candidate) => candidate.id === requested);
    if (plan === undefined) {
      throw new DocgenError({
        code: 'change-plan-not-found',
        message: `Plan '${requested}' does not exist.`,
        remedy: 'Create it with `docgen plan create`, or omit the unknown plan id.',
      });
    }
    planIds.push(plan.id);
    featureIds.add(plan.featureId);
  }
  if (featureIds.size === 0) {
    throw new DocgenError({
      code: 'change-feature-empty',
      message: 'A governed change must belong to at least one registered feature.',
      remedy: 'Pass `--features <id>` or a `--plans <id>` linked to a feature.',
    });
  }
  const impact = analyzeChangeImpact({
    current: run.graph,
    ...(baseline === undefined ? {} : { baseline }),
    changes: scopedChanges,
  });
  const surfaces = summarizeChangeSurfaces({ report: impact, outDir: config.outDir, includeChangelog: true });
  const outDir = config.outDir.split(path.sep).join('/').replace(/\/+$/, '');
  const generatedPages = [...new Set([
    ...surfaces.generatedPages,
    `${outDir}/features.md`,
    ...[...featureIds].map((id) => `${outDir}/features/${id}.md`),
    ...planIds.map((id) => `${outDir}/plans/${id}.md`),
    `${outDir}/changelog.md`,
  ])].sort();

  const parsed = changeRecordSchema.safeParse({
    schemaVersion: CHANGE_RECORD_SCHEMA_VERSION,
    id: options.id,
    kind: changeKind(options.kind),
    summary: options.summary,
    featureIds: [...featureIds],
    planIds,
    surfaceIds: surfaces.surfaceIds,
    requirementIds: surfaces.requirementIds,
    testFiles: surfaces.testFiles,
    generatedPages,
    base: scopedChanges.base,
    ...(head === undefined ? {} : { headCommit: head.sha, headDate: head.committedAt }),
    files: scopedChanges.changes,
    recordedBy: options.recordedBy ?? (await resolveGitUserEmail(config.root)) ?? 'unknown',
    recordedAt: options.recordedAt ?? new Date().toISOString(),
  });
  if (!parsed.success) {
    throw new DocgenError({
      code: 'change-input-invalid',
      message: `Cannot record change '${options.id}': ${parsed.error.issues[0]?.message ?? 'invalid input'}.`,
      remedy: 'Use a lowercase kebab-case id and non-empty summary with valid linked records.',
    });
  }
  const file = await writeNewChangeRecord(config.root, parsed.data);
  if (options.json === true) {
    options.logger.output(JSON.stringify({ file, change: parsed.data }, null, 2));
    return;
  }
  options.logger.heading('Change recorded');
  options.logger.info(`  id        ${parsed.data.id}`);
  options.logger.info(`  kind      ${parsed.data.kind}`);
  options.logger.info(`  features  ${parsed.data.featureIds.join(', ')}`);
  options.logger.info(`  plans     ${parsed.data.planIds.join(', ') || 'none'}`);
  options.logger.info(`  requirements ${parsed.data.requirementIds.join(', ') || 'none'}`);
  options.logger.info(`  tests     ${parsed.data.testFiles.join(', ') || 'none'}`);
  options.logger.info(`  pages     ${parsed.data.generatedPages.length}`);
  options.logger.info(`  files     ${parsed.data.files.length}`);
  options.logger.info(`  written   ${file}`);
}
