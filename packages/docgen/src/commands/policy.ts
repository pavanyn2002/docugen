import { loadConfig } from '../config/load.js';
import { loadFeatureRecords } from '../features/store.js';
import { evaluateGovernance } from '../governance/evaluate.js';
import { addGovernanceException, loadGovernanceExceptions } from '../governance/store.js';
import { governanceExceptionSchema } from '../governance/schema.js';
import { runExtraction } from '../pipeline.js';
import { colors } from '../util/colors.js';
import { DocgenError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

interface PolicyBaseOptions { readonly cwd: string; readonly configFile?: string; readonly json?: boolean; readonly logger: Logger; }
export interface PolicyCheckOptions extends PolicyBaseOptions { readonly base?: string; readonly asOf?: string; }
export interface PolicyExceptionAddOptions extends PolicyBaseOptions { readonly id: string; readonly policy: string; readonly subject?: string; readonly owner: string; readonly reason: string; readonly expiresAt: string; readonly recordedAt?: string; }

export function parsePolicyDate(value: string | undefined, label = '--as-of'): Date {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) throw new DocgenError({ code: 'governance-date-invalid', message: `${label} must be a valid ISO-8601 timestamp.`, remedy: 'Use a value such as 2026-12-31T23:59:59.000Z.' });
  return date;
}

export async function runPolicyCheckCommand(options: PolicyCheckOptions): Promise<void> {
  const config = await loadConfig({ root: options.cwd, ...(options.configFile === undefined ? {} : { configFile: options.configFile }) });
  const run = await runExtraction({ config, logger: options.logger, includeSymbols: (await loadFeatureRecords(config.root)).length > 0 });
  const report = await evaluateGovernance({ config, graph: run.graph, ...(options.base === undefined ? {} : { base: options.base }), now: parsePolicyDate(options.asOf) });
  if (options.json === true) options.logger.output(JSON.stringify(report, null, 2));
  else {
    options.logger.heading('Governance policies');
    options.logger.info(`  enabled      ${report.enabledPolicies.length}`);
    options.logger.info(`  violations   ${report.violations.length}`);
    options.logger.info(`  suppressed   ${report.suppressed.length}`);
    options.logger.info(`  expired      ${report.expiredExceptions.length}`);
    for (const violation of report.violations) options.logger.info(`  ${colors().red('fail')} ${violation.policy}/${violation.subject}: ${violation.message}`);
    for (const item of report.suppressed) options.logger.info(`  ${colors().dim('skip')} ${item.policy}/${item.subject}: exception ${item.exception.id} until ${item.exception.expiresAt}`);
  }
  if (!report.ok) throw new DocgenError({ code: 'governance-policy-failed', message: `${report.violations.length} governance policy violation(s) block this change.`, remedy: 'Fix the listed governance artifacts, or add an explicitly owned, time-bounded exception.' });
}

export async function runPolicyExceptionListCommand(options: PolicyBaseOptions & { readonly asOf?: string }): Promise<void> {
  const config = await loadConfig({ root: options.cwd, ...(options.configFile === undefined ? {} : { configFile: options.configFile }) });
  const record = await loadGovernanceExceptions(config.root);
  const now = parsePolicyDate(options.asOf).getTime();
  const exceptions = record.exceptions.map((item) => ({ ...item, status: Date.parse(item.expiresAt) <= now ? 'expired' : 'active' }));
  if (options.json === true) { options.logger.output(JSON.stringify({ count: exceptions.length, exceptions }, null, 2)); return; }
  options.logger.heading(`Governance exceptions (${exceptions.length})`);
  for (const item of exceptions) options.logger.info(`  ${item.id.padEnd(24)} ${item.policy}/${item.subject ?? '*'} [${item.status}] ${item.owner}`);
  if (exceptions.length === 0) options.logger.info(`  ${colors().dim('none recorded')}`);
}

export async function runPolicyExceptionAddCommand(options: PolicyExceptionAddOptions): Promise<void> {
  const config = await loadConfig({ root: options.cwd, ...(options.configFile === undefined ? {} : { configFile: options.configFile }) });
  const now = parsePolicyDate(options.recordedAt, '--recorded-at');
  const parsed = governanceExceptionSchema.safeParse({ id: options.id, policy: options.policy, ...(options.subject === undefined ? {} : { subject: options.subject }), owner: options.owner, reason: options.reason, expiresAt: options.expiresAt, recordedAt: now.toISOString() });
  if (!parsed.success) throw new DocgenError({ code: 'governance-exception-input-invalid', message: `Cannot add exception '${options.id}': ${parsed.error.issues[0]?.message ?? 'invalid input'}.`, remedy: 'Use a kebab-case id, valid policy, explicit owner and reason, and ISO-8601 expiry.' });
  const file = await addGovernanceException({ root: config.root, exception: parsed.data, now });
  const result = { file, exception: parsed.data };
  if (options.json === true) { options.logger.output(JSON.stringify(result, null, 2)); return; }
  options.logger.heading('Governance exception recorded');
  options.logger.info(`  id       ${parsed.data.id}`);
  options.logger.info(`  policy   ${parsed.data.policy}/${parsed.data.subject ?? '*'}`);
  options.logger.info(`  owner    ${parsed.data.owner}`);
  options.logger.info(`  expires  ${parsed.data.expiresAt}`);
  options.logger.info(`  written  ${file}`);
}
