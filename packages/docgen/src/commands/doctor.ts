import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { DEFAULT_FILE_FINGERPRINT_INDEX, readFileFingerprints } from '../graph/fingerprints.js';
import { DEFAULT_GRAPH_PARTITION_INDEX, readGraphPartitions } from '../graph/partition-store.js';
import { DEFAULT_GRAPH_INDEX, readEvidenceGraphIfExists } from '../graph/store.js';
import { inspectMigrations } from '../migrations/engine.js';
import { PILOT_MANIFEST_FILE, pilotManifestSchema } from '../pilot/schema.js';
import { findStaleAtomicFiles, removeAtomicFiles } from '../util/atomic.js';
import { describeUnknownError, DocgenError } from '../util/errors.js';
import { resolveCommitInfo } from '../util/git.js';
import type { Logger } from '../util/logger.js';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'fixed';
export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorCheckStatus;
  readonly message: string;
  readonly remedy?: string;
}
export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  readonly fix?: boolean;
  readonly json?: boolean;
  readonly logger: Logger;
}

export async function inspectRepositoryHealth(options: DoctorCommandOptions): Promise<DoctorReport> {
  const root = path.resolve(options.cwd);
  const checks: DoctorCheck[] = [];
  checks.push(checkNodeVersion());
  try {
    await loadConfig({ root, ...(options.configFile === undefined ? {} : { configFile: options.configFile }) });
    checks.push({ id: 'config', status: 'pass', message: 'Configuration loads and validates.' });
  } catch (error) {
    checks.push({ id: 'config', status: 'fail', message: describeUnknownError(error), remedy: error instanceof DocgenError ? error.remedy : 'Repair the configuration.' });
  }
  checks.push((await resolveCommitInfo(root)) === undefined
    ? { id: 'git', status: 'warn', message: 'No readable Git HEAD; dates and diff governance will be incomplete.', remedy: 'Run Docgen inside a committed Git repository.' }
    : { id: 'git', status: 'pass', message: 'Git HEAD is readable.' });

  const migrations = await inspectMigrations(root);
  const invalid = migrations.filter((item) => item.status === 'invalid' || item.status === 'unsupported');
  const pending = migrations.filter((item) => item.status === 'pending');
  checks.push(invalid.length > 0
    ? { id: 'schemas', status: 'fail', message: `${invalid.length} governed artifact(s) are invalid or newer than this engine.`, remedy: 'Repair them or upgrade Docgen; run `docgen migrate --dry-run --json` for details.' }
    : pending.length > 0
      ? { id: 'schemas', status: 'warn', message: `${pending.length} governed artifact(s) require migration.`, remedy: 'Review with `docgen migrate --dry-run`, then run `docgen migrate`.' }
      : { id: 'schemas', status: 'pass', message: 'Governed artifact schemas are current.' });

  const stale = await findStaleAtomicFiles(root);
  if (stale.length > 0 && options.fix === true) {
    await removeAtomicFiles(root, stale);
    checks.push({ id: 'interrupted-writes', status: 'fixed', message: `Removed ${stale.length} stale Docgen temporary file(s).` });
  } else if (stale.length > 0) {
    checks.push({ id: 'interrupted-writes', status: 'warn', message: `${stale.length} stale Docgen temporary file(s) indicate interrupted writes.`, remedy: 'Run `docgen doctor --fix` after confirming no Docgen process is active.' });
  } else checks.push({ id: 'interrupted-writes', status: 'pass', message: 'No stale Docgen temporary files.' });

  checks.push(await inspectCaches(root));
  checks.push(await inspectPilotEvidence(root));
  const ok = !checks.some((check) => check.status === 'fail');
  return { ok, checks };
}

export async function runDoctorCommand(options: DoctorCommandOptions): Promise<void> {
  const report = await inspectRepositoryHealth(options);
  if (options.json === true) options.logger.output(JSON.stringify(report, null, 2));
  else {
    options.logger.heading('docgen doctor');
    for (const check of report.checks) {
      options.logger.info(`  ${check.status.padEnd(5)} ${check.id.padEnd(20)} ${check.message}`);
      if (check.remedy !== undefined) options.logger.info(`        ${check.remedy}`);
    }
  }
  if (!report.ok) throw new DocgenError({ code: 'doctor-failed', message: 'Repository health checks failed.', remedy: 'Resolve the failed checks shown above, then rerun `docgen doctor`.' });
}

function checkNodeVersion(): DoctorCheck {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const supported = major > 20 || (major === 20 && minor >= 11);
  return supported
    ? { id: 'node', status: 'pass', message: `Node ${process.versions.node} is supported.` }
    : { id: 'node', status: 'fail', message: `Node ${process.versions.node} is unsupported.`, remedy: 'Install Node 20.11 or newer.' };
}

async function inspectCaches(root: string): Promise<DoctorCheck> {
  try {
    await Promise.all([
      readEvidenceGraphIfExists(path.join(root, DEFAULT_GRAPH_INDEX)),
      readFileFingerprints(path.join(root, DEFAULT_FILE_FINGERPRINT_INDEX)),
      readGraphPartitions(path.join(root, DEFAULT_GRAPH_PARTITION_INDEX)),
    ]);
    return { id: 'cache', status: 'pass', message: 'Present rebuildable indexes validate.' };
  } catch (error) {
    return { id: 'cache', status: 'warn', message: describeUnknownError(error), remedy: 'Delete .docgen/cache and rerun `docgen index`; human-owned data is unaffected.' };
  }
}

async function inspectPilotEvidence(root: string): Promise<DoctorCheck> {
  const file = path.join(root, PILOT_MANIFEST_FILE);
  try {
    const manifest = pilotManifestSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
    return manifest.reviewStatus === 'approved'
      ? { id: 'pilot-evidence', status: 'pass', message: `Pilot evidence is approved by ${manifest.reviewedBy}.` }
      : { id: 'pilot-evidence', status: 'warn', message: 'Pilot evidence is still a draft.', remedy: 'Have the attributed maintainer review the expectations, set reviewStatus to approved, and regenerate the pilot report.' };
  } catch (error) {
    if (isMissingFile(error)) return { id: 'pilot-evidence', status: 'pass', message: 'No optional pilot manifest is configured.' };
    return { id: 'pilot-evidence', status: 'fail', message: `Pilot manifest is invalid: ${describeUnknownError(error)}`, remedy: `Repair or remove ${PILOT_MANIFEST_FILE}.` };
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Used by packaging checks without accepting a missing root as healthy. */
export async function rootExists(root: string): Promise<boolean> {
  try { return (await fs.stat(root)).isDirectory(); } catch { return false; }
}
