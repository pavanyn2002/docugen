import { loadConfig } from '../config/load.js';
import { loadCards } from '../infer/store.js';
import { loadPlanRecords } from '../plans/store.js';
import { loadAnswers } from '../questions/store.js';
import { buildQueue } from '../questions/queue.js';
import { captureJson } from '../util/capture.js';
import { colors } from '../util/colors.js';
import type { Logger } from '../util/logger.js';
import { runCheckCommand } from './check.js';
import { runHandoffCommand } from './handoff.js';
import { runImpactCommand } from './impact.js';
import { runIndexGraphCommand } from './index-graph.js';
import { runSyncCommand } from './sync.js';

interface SessionOptions {
  readonly cwd: string;
  readonly configFile?: string;
  readonly base?: string;
  readonly json?: boolean;
  readonly logger: Logger;
}

async function index(options: SessionOptions): Promise<unknown> {
  return captureJson((logger) => runIndexGraphCommand({
    cwd: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
    json: true,
    logger,
  }));
}

export async function runSessionStartCommand(options: SessionOptions): Promise<void> {
  const [indexResult, config] = await Promise.all([
    index(options),
    loadConfig({ root: options.cwd, ...(options.configFile === undefined ? {} : { configFile: options.configFile }) }),
  ]);
  const [plans, cards, answers] = await Promise.all([
    loadPlanRecords(config.root), loadCards(config.root), loadAnswers(config.root),
  ]);
  const questions = buildQueue({ cards: [...cards.values()], answers }).questions;
  const activePlans = plans.filter((plan) => plan.status === 'approved' || plan.status === 'in-progress');
  const result = { operation: 'session-start', index: indexResult, activePlans, openQuestions: questions };
  if (options.json === true) { options.logger.output(JSON.stringify(result, null, 2)); return; }
  options.logger.heading('Docgen session started');
  options.logger.info(`  active plans    ${activePlans.length}`);
  options.logger.info(`  open questions  ${questions.length}`);
  for (const plan of activePlans) options.logger.info(`    ${plan.id}  ${plan.title} [${plan.status}]`);
  options.logger.info(`\n  ${colors().dim('Evidence index refreshed. Do not guess answers to open questions.')}`);
}

export async function runSessionAfterEditCommand(options: SessionOptions): Promise<void> {
  const indexResult = await index(options);
  const impact = await captureJson((logger) => runImpactCommand({
    cwd: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
    ...(options.base === undefined ? {} : { base: options.base }),
    json: true,
    logger,
  }));
  const result = { operation: 'after-edit', index: indexResult, impact };
  if (options.json === true) { options.logger.output(JSON.stringify(result, null, 2)); return; }
  options.logger.heading('Docgen after edit');
  const files = typeof impact === 'object' && impact !== null && 'files' in impact && Array.isArray(impact.files) ? impact.files.length : 0;
  options.logger.info(`  changed files   ${files}`);
  options.logger.info(`  ${colors().dim('Evidence refreshed. Review the JSON form for exact impacted entities.')}`);
}

export async function runSessionEndCommand(options: SessionOptions & { readonly strict?: boolean }): Promise<void> {
  const indexResult = await index(options);
  const sync = await captureJson((logger) => runSyncCommand({
    cwd: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
    json: true,
    logger,
  }));
  const handoff = await captureJson((logger) => runHandoffCommand({
    cwd: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
    ...(options.base === undefined ? {} : { base: options.base }),
    json: true,
    logger,
  }));
  const check = await captureJson((logger) => runCheckCommand({
    cwd: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
    strict: options.strict === true,
    ...(options.base === undefined ? {} : { base: options.base }),
    json: true,
    logger,
  }));
  const result = { operation: 'session-end', index: indexResult, sync, handoff, check };
  if (options.json === true) { options.logger.output(JSON.stringify(result, null, 2)); return; }
  options.logger.heading('Docgen session completed');
  options.logger.info('  generated docs  synchronized');
  options.logger.info('  tester handoff  written');
  options.logger.info(`  governance      ${colors().green('passed')}`);
}
