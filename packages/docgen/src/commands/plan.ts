import { loadConfig } from '../config/load.js';
import { findFeatureRecord } from '../features/graph.js';
import { loadFeatureRecords } from '../features/store.js';
import { PLAN_RECORD_SCHEMA_VERSION, PLAN_STATUSES, planRecordSchema } from '../plans/schema.js';
import type { PlanStatus } from '../plans/schema.js';
import { loadPlanRecords, updatePlanStatus, writeNewPlanRecord } from '../plans/store.js';
import { colors } from '../util/colors.js';
import { DocgenError } from '../util/errors.js';
import { resolveGitUserEmail } from '../util/git.js';
import type { Logger } from '../util/logger.js';

interface PlanCommandBase {
  readonly cwd: string;
  readonly configFile?: string;
  readonly json?: boolean;
  readonly logger: Logger;
}

export interface PlanCreateCommandOptions extends PlanCommandBase {
  readonly id: string;
  readonly feature: string;
  readonly title: string;
  readonly summary: string;
  readonly status?: string;
  readonly acceptance?: readonly string[];
  readonly risks?: readonly string[];
  readonly testNotes?: readonly string[];
  readonly recordedBy?: string;
  readonly recordedAt?: string;
}

export interface PlanShowCommandOptions extends PlanCommandBase {
  readonly id: string;
}

export interface PlanStatusCommandOptions extends PlanCommandBase {
  readonly id: string;
  readonly status: string;
  readonly note?: string;
  readonly changedBy?: string;
  readonly changedAt?: string;
}

function planStatus(value: string | undefined): PlanStatus {
  const resolved = value ?? 'draft';
  const status = PLAN_STATUSES.find((candidate) => candidate === resolved);
  if (status !== undefined) return status;
  throw new DocgenError({
    code: 'plan-status-invalid',
    message: `Unknown plan status '${resolved}'.`,
    remedy: `Valid values are: ${PLAN_STATUSES.join(', ')}.`,
  });
}

export async function runPlanCreateCommand(options: PlanCreateCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const feature = findFeatureRecord(await loadFeatureRecords(config.root), options.feature);
  if (feature === undefined) {
    throw new DocgenError({
      code: 'plan-feature-not-found',
      message: `Cannot create plan '${options.id}': feature '${options.feature}' is not registered.`,
      remedy: 'Register the feature first with `docgen feature add`, or use an existing id or alias.',
    });
  }
  const parsed = planRecordSchema.safeParse({
    schemaVersion: PLAN_RECORD_SCHEMA_VERSION,
    id: options.id,
    featureId: feature.id,
    title: options.title,
    summary: options.summary,
    status: planStatus(options.status),
    acceptanceCriteria: (options.acceptance ?? []).map((text, index) => ({
      id: `AC-${String(index + 1).padStart(2, '0')}`,
      text,
    })),
    risks: options.risks ?? [],
    testNotes: options.testNotes ?? [],
    recordedBy: options.recordedBy ?? (await resolveGitUserEmail(config.root)) ?? 'unknown',
    recordedAt: options.recordedAt ?? new Date().toISOString(),
  });
  if (!parsed.success) {
    throw new DocgenError({
      code: 'plan-input-invalid',
      message: `Cannot create plan '${options.id}': ${parsed.error.issues[0]?.message ?? 'invalid input'}.`,
      remedy: 'Use a lowercase kebab-case id and non-empty title, summary, and repeated text values.',
    });
  }
  const file = await writeNewPlanRecord(config.root, parsed.data);
  if (options.json === true) {
    options.logger.output(JSON.stringify({ file, plan: parsed.data }, null, 2));
    return;
  }
  options.logger.heading('Plan created');
  options.logger.info(`  id          ${parsed.data.id}`);
  options.logger.info(`  feature     ${parsed.data.featureId}`);
  options.logger.info(`  status      ${parsed.data.status}`);
  options.logger.info(`  acceptance  ${parsed.data.acceptanceCriteria.length}`);
  options.logger.info(`  written     ${file}`);
}

export async function runPlanListCommand(options: PlanCommandBase): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const plans = await loadPlanRecords(config.root);
  if (options.json === true) {
    options.logger.output(JSON.stringify({ count: plans.length, plans }, null, 2));
    return;
  }
  options.logger.heading(`Plans (${plans.length})`);
  for (const plan of plans) {
    options.logger.info(`  ${plan.id.padEnd(24)} ${plan.title} ${colors().dim(`[${plan.featureId}/${plan.status}]`)}`);
  }
  if (plans.length === 0) options.logger.info(`  ${colors().dim('none recorded; use docgen plan create')}`);
}

export async function runPlanShowCommand(options: PlanShowCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const plan = (await loadPlanRecords(config.root)).find((candidate) => candidate.id === options.id);
  if (plan === undefined) {
    throw new DocgenError({
      code: 'plan-not-found',
      message: `Plan '${options.id}' does not exist.`,
      remedy: 'Run `docgen plan list`, or create it with `docgen plan create`.',
    });
  }
  if (options.json === true) {
    options.logger.output(JSON.stringify(plan, null, 2));
    return;
  }
  options.logger.heading(plan.title);
  options.logger.info(`  id          ${plan.id}`);
  options.logger.info(`  feature     ${plan.featureId}`);
  options.logger.info(`  status      ${plan.status}`);
  options.logger.info(`  summary     ${plan.summary}`);
  options.logger.heading(`Acceptance criteria (${plan.acceptanceCriteria.length})`);
  for (const criterion of plan.acceptanceCriteria) options.logger.info(`  ${criterion.id}  ${criterion.text}`);
  options.logger.heading(`Risks (${plan.risks.length})`);
  for (const risk of plan.risks) options.logger.info(`  - ${risk}`);
  options.logger.heading(`Test notes (${plan.testNotes.length})`);
  for (const note of plan.testNotes) options.logger.info(`  - ${note}`);
  options.logger.heading(`Status history (${plan.transitions.length})`);
  for (const transition of plan.transitions) {
    options.logger.info(
      `  ${transition.from} -> ${transition.to}  ${transition.changedBy}  ${transition.changedAt}${transition.note === undefined ? '' : `  ${transition.note}`}`,
    );
  }
}

export async function runPlanStatusCommand(options: PlanStatusCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const updated = await updatePlanStatus({
    root: config.root,
    id: options.id,
    status: planStatus(options.status),
    changedBy: options.changedBy ?? (await resolveGitUserEmail(config.root)) ?? 'unknown',
    changedAt: options.changedAt ?? new Date().toISOString(),
    ...(options.note === undefined ? {} : { note: options.note }),
  });
  if (options.json === true) {
    options.logger.output(JSON.stringify(updated, null, 2));
    return;
  }
  const transition = updated.transitions.at(-1);
  options.logger.heading('Plan status updated');
  options.logger.info(`  plan        ${updated.id}`);
  options.logger.info(`  transition  ${transition?.from ?? '?'} -> ${updated.status}`);
  options.logger.info(`  recorded    ${transition?.changedBy ?? 'unknown'} at ${transition?.changedAt ?? 'unknown'}`);
}
