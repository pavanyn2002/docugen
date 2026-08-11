import { loadConfig } from '../config/load.js';
import { deriveFeatureCommitHistory } from '../features/history.js';
import { findFeatureRecord, matchingFeatureNodeIds } from '../features/graph.js';
import { FEATURE_CRITICALITIES, FEATURE_RECORD_SCHEMA_VERSION, FEATURE_STATUSES, featureRecordSchema } from '../features/schema.js';
import type { FeatureCriticality, FeatureStatus } from '../features/schema.js';
import { loadFeatureRecords, writeNewFeatureRecord } from '../features/store.js';
import { runExtraction } from '../pipeline.js';
import { colors } from '../util/colors.js';
import { DocgenError } from '../util/errors.js';
import { resolveGitUserEmail } from '../util/git.js';
import type { Logger } from '../util/logger.js';

interface FeatureCommandBase {
  readonly cwd: string;
  readonly configFile?: string;
  readonly json?: boolean;
  readonly logger: Logger;
}

export interface FeatureAddCommandOptions extends FeatureCommandBase {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly aliases?: string;
  readonly files?: string;
  readonly nodes?: string;
  readonly owners?: string;
  readonly status?: string;
  readonly criticality?: string;
  /** Test/embedding overrides; CLI calls use the current attributed time. */
  readonly recordedBy?: string;
  readonly recordedAt?: string;
}

export interface FeatureShowCommandOptions extends FeatureCommandBase {
  readonly id: string;
}

function list(value: string | undefined): readonly string[] {
  return [...new Set((value ?? '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function enumValue<T extends string>(value: string | undefined, valid: readonly T[], label: string, fallback: T): T {
  if (value === undefined) return fallback;
  const found = valid.find((candidate) => candidate === value);
  if (found !== undefined) return found;
  throw new DocgenError({
    code: `feature-${label}-invalid`,
    message: `Unknown feature ${label} '${value}'.`,
    remedy: `Valid values are: ${valid.join(', ')}.`,
  });
}

export async function runFeatureAddCommand(options: FeatureAddCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const parsed = featureRecordSchema.safeParse({
    schemaVersion: FEATURE_RECORD_SCHEMA_VERSION,
    id: options.id,
    title: options.title,
    ...(options.description === undefined ? {} : { description: options.description }),
    aliases: list(options.aliases),
    status: enumValue(options.status, FEATURE_STATUSES, 'status', 'active' satisfies FeatureStatus),
    owners: list(options.owners),
    criticality: enumValue(
      options.criticality,
      FEATURE_CRITICALITIES,
      'criticality',
      'medium' satisfies FeatureCriticality,
    ),
    selectors: { files: list(options.files), nodes: list(options.nodes) },
    recordedBy: options.recordedBy ?? (await resolveGitUserEmail(config.root)) ?? 'unknown',
    recordedAt: options.recordedAt ?? new Date().toISOString(),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DocgenError({
      code: 'feature-input-invalid',
      message: `Cannot create feature '${options.id}': ${issue?.message ?? 'invalid input'}.`,
      remedy: 'Use a lowercase kebab-case id, repo-relative selectors, and non-empty metadata.',
    });
  }
  const record = parsed.data;
  const file = await writeNewFeatureRecord(config.root, record);
  if (options.json === true) {
    options.logger.output(JSON.stringify({ file, record }, null, 2));
    return;
  }
  options.logger.heading('Feature registered');
  options.logger.info(`  id          ${record.id}`);
  options.logger.info(`  title       ${record.title}`);
  options.logger.info(`  selectors   ${record.selectors.files.length} file, ${record.selectors.nodes.length} node`);
  options.logger.info(`  written     ${file}`);
}

export async function runFeatureListCommand(options: FeatureCommandBase): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const records = await loadFeatureRecords(config.root);
  if (options.json === true) {
    options.logger.output(JSON.stringify({ count: records.length, features: records }, null, 2));
    return;
  }
  options.logger.heading(`Features (${records.length})`);
  for (const record of records) {
    options.logger.info(`  ${record.id.padEnd(24)} ${record.title} ${colors().dim(`[${record.status}/${record.criticality}]`)}`);
  }
  if (records.length === 0) options.logger.info(`  ${colors().dim('none registered; use docgen feature add')}`);
}

export async function runFeatureShowCommand(options: FeatureShowCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const records = await loadFeatureRecords(config.root);
  const record = findFeatureRecord(records, options.id);
  if (record === undefined) {
    throw new DocgenError({
      code: 'feature-not-found',
      message: `Feature '${options.id}' is not registered.`,
      remedy: 'Run `docgen feature list`, or create it with `docgen feature add`.',
    });
  }
  const run = await runExtraction({ config, logger: options.logger, includeSymbols: true });
  const nodeIds = matchingFeatureNodeIds(run.graph, record);
  const history = await deriveFeatureCommitHistory({ root: config.root, graph: run.graph, record });
  const result = { record, history, matchedNodeCount: nodeIds.length, matchedNodeIds: nodeIds };
  if (options.json === true) {
    options.logger.output(JSON.stringify(result, null, 2));
    return;
  }
  options.logger.heading(record.title);
  options.logger.info(`  id           ${record.id}`);
  options.logger.info(`  status       ${record.status}`);
  options.logger.info(`  criticality  ${record.criticality}`);
  options.logger.info(`  owners       ${record.owners.join(', ') || 'unassigned'}`);
  options.logger.info(`  graph nodes  ${nodeIds.length}`);
  if (history === undefined) {
    options.logger.info(`  history      ${colors().dim('no committed selected files')}`);
  } else {
    options.logger.info(`  introduced   ${history.introduced.committedAt} ${history.introduced.sha.slice(0, 12)}`);
    options.logger.info(`  last changed ${history.lastChanged.committedAt} ${history.lastChanged.sha.slice(0, 12)}`);
  }
  options.logger.info(`  record       ${record.sourceFile}`);
}
