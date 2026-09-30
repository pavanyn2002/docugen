import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFeatureAddCommand, runFeatureListCommand, runFeatureShowCommand } from '../src/commands/feature.js';
import { runPlanCreateCommand, runPlanListCommand, runPlanShowCommand, runPlanStatusCommand } from '../src/commands/plan.js';
import { runGraphSearchCommand, runGraphExplainCommand, runGraphPathCommand, parseGraphDirection } from '../src/commands/query-graph.js';
import { runImpactCommand } from '../src/commands/impact.js';
import { runChangeRecordCommand } from '../src/commands/change.js';
import { runInitCommand, resolveDefaultBranch, resolveInvocation } from '../src/commands/init.js';
import { runSecurityScanCommand, runSecuritySbomCommand } from '../src/commands/security.js';
import { runPilotCommand } from '../src/commands/pilot.js';
import { runDoctorCommand, rootExists } from '../src/commands/doctor.js';
import { runPolicyExceptionAddCommand, runPolicyExceptionListCommand } from '../src/commands/policy.js';
import { runSessionStartCommand, runSessionAfterEditCommand, runSessionEndCommand } from '../src/commands/session.js';
import { runIndexGraphCommand } from '../src/commands/index-graph.js';
import { runMigrateCommand } from '../src/commands/migrate.js';
import { loadFeatureRecords } from '../src/features/store.js';
import { loadChangeRecords } from '../src/changes/store.js';
import { ENGINE_VERSION } from '../src/util/version.js';
import type { Logger } from '../src/util/logger.js';
import { createRepository, seedGovernance } from './helpers/repository.js';

let root: string;
const messages: string[] = [];
const outputs: string[] = [];
const logger: Logger = { level: 'debug', error: (s) => messages.push(s), warn: (s) => messages.push(s), info: (s) => messages.push(s), debug: (s) => messages.push(s), heading: (s) => messages.push(s), output: (s) => outputs.push(s) };
const options = () => ({ cwd: root, logger });
const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(root, '.git', 'disabled-hooks')}`, ...args], { cwd: root, windowsHide: true, stdio: 'pipe' });
async function write(file: string, text: string) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); }
beforeEach(async () => { root = await createRepository(); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); messages.length = 0; outputs.length = 0; await fs.rm(root, { recursive: true, force: true }); });

describe('governed command validation and readable records', () => {
  it('creates attributed features and renders committed and uncommitted histories', async () => {
    await runFeatureAddCommand({ ...options(), id: 'committed', title: 'Committed', files: 'app/**', recordedBy: 'owner', recordedAt: '2026-09-30T00:00:00Z' });
    await runFeatureAddCommand({ ...options(), configFile: 'docgen.config.json', id: 'uncommitted', title: 'Uncommitted', nodes: 'file:new.ts' });
    await runFeatureListCommand(options());
    await runFeatureShowCommand({ ...options(), id: 'committed' });
    await runFeatureShowCommand({ ...options(), configFile: 'docgen.config.json', id: 'uncommitted' });
    expect(messages.join('\n')).toContain('introduced');
    expect(messages.join('\n')).toContain('no committed selected files');
    expect(messages.join('\n')).toContain('unassigned');
  });
  it.each([
    { id: 'BAD ID', title: 'Feature' }, { id: 'good', title: '' }, { id: 'good', title: 'Feature', status: 'bad' }, { id: 'good', title: 'Feature', criticality: 'bad' },
  ])('rejects invalid feature input $id $status $criticality', async (args) => {
    await expect(runFeatureAddCommand({ ...options(), ...args })).rejects.toThrow();
    expect(await loadFeatureRecords(root)).toEqual([]);
  });
  it('attributes non-Git feature and plan changes as unknown', async () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'no-global-config'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    await fs.rm(path.join(root, '.git'), { recursive: true });
    await runFeatureAddCommand({ ...options(), id: 'feature', title: 'Feature', json: true });
    expect(JSON.parse(outputs[0]!).record.recordedBy).toBe('unknown');
    await runPlanCreateCommand({ ...options(), id: 'plan', feature: 'feature', title: 'Plan', summary: 'Work' });
    await runPlanStatusCommand({ ...options(), id: 'plan', status: 'approved' });
    expect(messages.join('\n')).toContain('unknown');
  });
  it('renders plans with empty collections and transitions without a note', async () => {
    await seedGovernance(root);
    await runPlanCreateCommand({ ...options(), id: 'minimal-plan', feature: 'home', title: 'Minimal', summary: 'Work', recordedBy: 'owner', recordedAt: '2026-09-30T00:00:00Z' });
    await runPlanStatusCommand({ ...options(), id: 'minimal-plan', status: 'approved', changedBy: 'reviewer', changedAt: '2026-09-30T01:00:00Z' });
    await runPlanShowCommand({ ...options(), id: 'minimal-plan' });
    await runPlanListCommand(options());
    expect(messages.join('\n')).toContain('draft -> approved');
    expect(messages.join('\n')).toContain('Acceptance criteria (0)');
  });
  it.each([{ status: 'bad' }, { id: 'BAD' }, { title: '' }, { summary: '' }, { acceptance: [''] }])('rejects invalid plan input %j', async (patch) => {
    await seedGovernance(root);
    await expect(runPlanCreateCommand({ ...options(), id: 'plan', feature: 'home', title: 'Plan', summary: 'Work', ...patch })).rejects.toThrow();
  });
});

describe('graph command human reports', () => {
  it('renders both directions of evidence and paths with zero, one, and multiple edges', async () => {
    await write('app/utility.ts', 'export function helper() { return 1; }\n');
    await write('app/page.tsx', 'import { helper } from "./utility"; export default function Home() { return helper(); }\n');
    await runGraphSearchCommand({ ...options(), text: 'no-match', kinds: 'file', limit: 0 });
    await runGraphSearchCommand({ ...options(), configFile: 'docgen.config.json', text: 'app' });
    await runGraphExplainCommand({ ...options(), id: 'file:app/page.tsx' });
    await runGraphSearchCommand({ ...options(), text: 'helper', json: true });
    const symbol = JSON.parse(outputs.pop()!).nodes.find((node: { kind: string }) => node.kind === 'symbol');
    expect(symbol).toBeDefined();
    await runGraphExplainCommand({ ...options(), id: symbol.id });
    await runGraphPathCommand({ ...options(), from: symbol.id, to: 'file:app/utility.ts', direction: 'outgoing' });
    await runGraphPathCommand({ ...options(), from: 'file:app/page.tsx', to: 'file:app/page.tsx' });
    await runGraphPathCommand({ ...options(), from: 'file:app/page.tsx', to: 'file:app/utility.ts', direction: 'outgoing' });
    await runGraphPathCommand({ ...options(), from: 'file:app/utility.ts', to: 'file:app/page.tsx', direction: 'outgoing', maxDepth: 1 });
    await expect(runGraphPathCommand({ ...options(), from: 'file:app/utility.ts', to: 'file:app/page.tsx', maxDepth: 0 })).rejects.toMatchObject({ code: 'graph-query-depth-invalid' });
    await runGraphPathCommand({ ...options(), from: 'file:app/page.tsx', to: symbol.id, direction: 'both' });
    expect(messages.join('\n')).toContain('no matching nodes');
    expect(messages.join('\n')).toContain('Graph path (1 edge)');
    expect(messages.join('\n')).toContain('No graph path');
    expect(messages.join('\n')).toContain('<-');
    expect(parseGraphDirection('incoming')).toBe('incoming');
  });
  it.each([-1, 1.5, NaN])('rejects invalid impact limits %s', async (limit) => {
    await expect(runImpactCommand({ ...options(), limit })).rejects.toMatchObject({ code: 'impact-limit-invalid' });
  });
  it('describes clean worktrees, modified files, additions, deletions, and truncation', async () => {
    await runImpactCommand(options());
    await runImpactCommand({ ...options(), json: true });
    await runIndexGraphCommand(options());
    await write('app/page.tsx', 'export default function Home() { return "updated"; }');
    await runImpactCommand({ ...options(), configFile: 'docgen.config.json', limit: 0 });
    await write('app/new.ts', 'export const newValue = 1;');
    await runImpactCommand({ ...options(), limit: 10 });
    await fs.rm(path.join(root, 'app/page.tsx'));
    await runImpactCommand(options());
    expect(messages.join('\n')).toContain('no changes relative');
    expect(messages.join('\n')).toContain('more; use --limit');
    expect(messages.join('\n')).toContain('previous index loaded');
    expect(messages.join('\n')).toContain('introduced');
  });
  it('reports renamed files with their original committed history', async () => {
    git('mv', 'app/page.tsx', 'app/renamed.tsx');
    await runImpactCommand(options());
    expect(messages.join('\n')).toContain('<- app/page.tsx');
    expect(messages.join('\n')).toContain('introduced');
  });
});

describe('immutable change command errors and evidence', () => {
  it('requires relevant changes before recording', async () => {
    await expect(runChangeRecordCommand({ ...options(), id: 'change', summary: 'Changed', features: 'home' })).rejects.toMatchObject({ code: 'change-files-empty' });
  });
  it.each([
    { features: 'missing', code: 'change-feature-not-found' }, { plans: 'missing', code: 'change-plan-not-found' },
    { features: '', code: 'change-feature-empty' }, { kind: 'invalid', code: 'change-kind-invalid' }, { id: 'BAD', code: 'change-input-invalid' },
  ])('rejects a change with $code', async ({ code, ...patch }) => {
    await seedGovernance(root);
    await write('app/page.tsx', 'export default function Home() { return "changed"; }');
    await expect(runChangeRecordCommand({ ...options(), id: 'change', summary: 'Changed', features: 'home', ...patch })).rejects.toMatchObject({ code });
    expect(await loadChangeRecords(root)).toEqual([]);
  });
  it('records default kind and attribution overrides in readable output', async () => {
    await seedGovernance(root);
    await runIndexGraphCommand(options());
    await write('app/page.tsx', 'export default function Home() { return "changed"; }');
    await runChangeRecordCommand({ ...options(), id: 'change', summary: 'Changed', features: '', plans: 'home-update', recordedBy: 'owner', recordedAt: '2026-09-30T00:00:00Z' });
    expect((await loadChangeRecords(root))[0]).toMatchObject({ kind: 'feature', recordedBy: 'owner', featureIds: ['home'] });
    expect(messages.join('\n')).toContain('Change recorded');
  });
});

describe('installation and operational commands', () => {
  it('installs adapters and reports unchanged outcomes on subsequent runs', async () => {
    await runInitCommand(options());
    await runInitCommand({ ...options(), configFile: 'docgen.config.json', all: true, hooks: true });
    await runInitCommand({ ...options(), all: true, hooks: true });
    expect(messages.join('\n')).toContain('created');
    expect(messages.join('\n')).toContain('unchanged');
    expect(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8')).toContain('docgen');
  });
  it('resolves default branch from remote HEAD, local branch, detached HEAD, and missing Git', async () => {
    const local = git('branch', '--show-current').toString().trim();
    expect(await resolveDefaultBranch(root)).toBe(local);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    expect(await resolveDefaultBranch(root)).toBe('main');
    git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    git('checkout', '--detach');
    expect(await resolveDefaultBranch(root)).toBe('main');
    expect(await resolveDefaultBranch(path.join(root, 'missing'))).toBe('main');
  });
  it.each([
    { dependencies: { '@pavanyn/docugen': '1.0.4' } }, { devDependencies: { '@pavanyn/docugen': '1.0.4' } }, {},
  ])('resolves a local dependency invocation from manifest %j', async (manifest) => {
    await write('package.json', JSON.stringify(manifest));
    expect(await resolveInvocation(root)).toBe(Object.keys(manifest).length ? 'npx docgen' : `npx --yes @pavanyn/docugen@${ENGINE_VERSION}`);
    await write('package.json', '{invalid');
    expect(await resolveInvocation(root)).toContain('@pavanyn/docugen@');
  });
  it('prints supply-chain risks and writes, previews, and diagnoses SBOM output', async () => {
    await runSecurityScanCommand(options());
    await expect(runSecurityScanCommand({ ...options(), strict: true })).rejects.toThrow('--strict');
    await runSecuritySbomCommand(options());
    expect(JSON.parse(await fs.readFile(path.join(root, 'docs/.security/sbom.cdx.json'), 'utf8')).bomFormat).toBe('CycloneDX');
    await runSecuritySbomCommand({ ...options(), out: 'docs/preview.json', dryRun: true });
    await expect(fs.stat(path.join(root, 'docs/preview.json'))).rejects.toThrow();
    await runSecuritySbomCommand({ ...options(), out: '.', dryRun: true });
    await write('blocked', 'file');
    await expect(runSecuritySbomCommand({ ...options(), out: 'blocked/sbom.json' })).rejects.toMatchObject({ code: 'sbom-write-failed' });
  });
  it('passes a strict supply-chain check with reproducible empty dependency metadata', async () => {
    await write('package.json', '{"name":"fixture","version":"1.0.0"}');
    await write('package-lock.json', '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}');
    await runSecurityScanCommand({ ...options(), strict: true, json: true });
    expect(JSON.parse(outputs[0]!).findings).toEqual([]);
  });
  it('renders, writes, and exposes a reviewed pilot report', async () => {
    const manifest = { schemaVersion: 1, repository: 'fixture', repositoryClass: 'frontend', reviewStatus: 'approved', reviewedBy: 'maintainer', reviewedAt: '2026-09-30T00:00:00Z', expectations: { technologies: [], graphGaps: [] } };
    await write('docgen.pilot.json', JSON.stringify(manifest));
    await runPilotCommand(options());
    expect(outputs.pop()).toContain('pilot');
    await runPilotCommand({ ...options(), manifest: 'docgen.pilot.json', out: 'docs/pilot.md' });
    expect(await fs.readFile(path.join(root, 'docs/pilot.md'), 'utf8')).toContain('fixture');
    await runPilotCommand({ ...options(), json: true });
    expect(JSON.parse(outputs.pop()!)).toHaveProperty('repository');
  });
  it('reports repository health and distinguishes invalid optional pilot evidence', async () => {
    await runDoctorCommand(options());
    expect(messages.join('\n')).toContain('Configuration loads');
    await write('docgen.pilot.json', '{bad');
    await expect(runDoctorCommand(options())).rejects.toMatchObject({ code: 'doctor-failed' });
    expect(await rootExists(root)).toBe(true);
    expect(await rootExists(path.join(root, 'package.json'))).toBe(false);
    expect(await rootExists(path.join(root, 'missing'))).toBe(false);
  });
  it('reports already current migration state in machine and readable forms', async () => {
    await runMigrateCommand({ ...options(), dryRun: true });
    await runMigrateCommand({ ...options(), dryRun: true, json: true });
    await runMigrateCommand(options());
    await runMigrateCommand({ ...options(), json: true });
    expect(messages.join('\n')).toContain('already use current schemas');
    expect(JSON.parse(outputs.pop()!)).toEqual({ changes: [] });
  });
  it('records active and expired governance exceptions with wildcard and explicit subjects', async () => {
    for (const [id, subject, json] of [['global', undefined, false], ['feature', 'home', true]] as const) {
      await runPolicyExceptionAddCommand({ ...options(), configFile: 'docgen.config.json', id, policy: 'changed-feature-plan', ...(subject === undefined ? {} : { subject }), owner: 'owner', reason: 'Migration', expiresAt: '2027-01-01T00:00:00Z', recordedAt: '2026-09-30T00:00:00Z', json });
    }
    await runPolicyExceptionListCommand({ ...options(), asOf: '2026-09-30T00:00:00Z' });
    await runPolicyExceptionListCommand({ ...options(), asOf: '2028-01-01T00:00:00Z', json: true });
    expect(messages.join('\n')).toContain('[active]');
    expect(JSON.parse(outputs.pop()!).exceptions.every((item: { status: string }) => item.status === 'expired')).toBe(true);
    await expect(runPolicyExceptionAddCommand({ ...options(), id: 'BAD', policy: 'invalid', owner: '', reason: '', expiresAt: 'bad' })).rejects.toMatchObject({ code: 'governance-exception-input-invalid' });
  });
  it('executes readable session lifecycle and exposes active plans', async () => {
    await seedGovernance(root);
    await runPlanStatusCommand({ ...options(), id: 'home-update', status: 'approved' });
    await runSessionStartCommand(options());
    await runPlanStatusCommand({ ...options(), id: 'home-update', status: 'in-progress' });
    await runSessionStartCommand({ ...options(), configFile: 'docgen.config.json', base: 'HEAD', json: true });
    await runSessionAfterEditCommand(options());
    await runSessionAfterEditCommand({ ...options(), configFile: 'docgen.config.json', base: 'HEAD', json: true });
    await runSessionEndCommand(options());
    await runSessionEndCommand({ ...options(), configFile: 'docgen.config.json', base: 'HEAD', json: true });
    expect(messages.join('\n')).toContain('Docgen session completed');
    expect(messages.join('\n')).toContain('home-update');
    expect(JSON.parse(outputs.pop()!).operation).toBe('session-end');
  }, 30_000);
});
