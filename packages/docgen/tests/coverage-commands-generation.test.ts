import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBootstrapCommand } from '../src/commands/bootstrap.js';
import { runIndexGraphCommand } from '../src/commands/index-graph.js';
import { runExtractCommand } from '../src/commands/extract.js';
import { runReportCommand } from '../src/commands/report.js';
import { runStatusCommand } from '../src/commands/status.js';
import { runDoctorCommand } from '../src/commands/doctor.js';
import { runMigrateCommand } from '../src/commands/migrate.js';
import { runCheckCommand } from '../src/commands/check.js';
import { runPolicyCheckCommand, runPolicyExceptionAddCommand } from '../src/commands/policy.js';
import { runTraceCommand } from '../src/commands/trace.js';
import { runSyncCommand } from '../src/commands/sync.js';
import { loadCards, saveCards } from '../src/infer/store.js';
import * as registry from '../src/agents/registry.js';
import type { Logger } from '../src/util/logger.js';
import { createRepository, homeCard, seedGovernance } from './helpers/repository.js';
import { DEFAULT_GRAPH_INDEX } from '../src/graph/store.js';
import { MIGRATIONS_DIR } from '../src/config/paths.js';
import type { FeatureCard } from '../src/infer/types.js';

let root: string;
const messages: string[] = [];
const outputs: string[] = [];
const logger: Logger = { level: 'debug', error: (s) => messages.push(s), warn: (s) => messages.push(s), info: (s) => messages.push(s), debug: (s) => messages.push(s), heading: (s) => messages.push(s), output: (s) => outputs.push(s) };
const options = () => ({ cwd: root, logger });
async function write(file: string, text: string) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); }
const configuration = (value: Record<string, unknown>) => write('docgen.config.json', JSON.stringify({ include: ['app/**', 'package.json'], ...value }));
beforeEach(async () => { root = await createRepository(); });
afterEach(async () => { vi.restoreAllMocks(); messages.length = 0; outputs.length = 0; await fs.rm(root, { recursive: true, force: true }); });

describe('bounded inference commands', () => {
  it('runs a successful model response, reuses cards, and retains targets outside the run limit', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, text: JSON.stringify(homeCard().body) });
    vi.spyOn(registry, 'resolveBackend').mockResolvedValue({ id: 'fixture', name: 'Fixture', setupHint: '', isAvailable: async () => true, run });
    await saveCards(root, [{ ...homeCard(), surfaceId: 'screen:/other', slug: 'other', body: { ...homeCard().body, summary: { text: 'Other', evidence: [{ file: 'app/other/page.tsx', line: 1 }] } } }]);
    await write('app/other/page.tsx', 'export default function Other() { return null; }');
    await configuration({ infer: { model: 'fixture-model' }, privacy: { allowedModels: ['fixture-model'] } });
    await runBootstrapCommand({ ...options(), configFile: 'docgen.config.json', limit: 1, force: true });
    expect(await loadCards(root)).toHaveProperty('size', 2);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ model: 'fixture-model' }));
    expect(messages.join('\n')).toContain('questions');
    await runBootstrapCommand({ ...options(), limit: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(messages.join('\n')).toContain('reused unchanged');
  });
  it('reports every model failure and summarizes failures beyond ten surfaces', async () => {
    await fs.rm(path.join(root, 'app/page.tsx'));
    for (let index = 0; index < 11; index++) await write(`app/surface${index}/page.tsx`, `export default function Page${index}() { return null; }`);
    vi.spyOn(registry, 'resolveBackend').mockResolvedValue({ id: 'fixture', name: 'Fixture', setupHint: '', isAvailable: async () => true, run: vi.fn().mockResolvedValue({ ok: false, reason: 'Service unavailable' }) });
    await runBootstrapCommand(options());
    expect((await loadCards(root)).size).toBe(0);
    expect(messages.join('\n')).toContain('11 surface(s) could not be described');
    expect(messages.join('\n')).toContain('and 1 more');
  });
  it('reports empty repositories before resolving model backends', async () => {
    await fs.rm(path.join(root, 'app'), { recursive: true });
    const backend = vi.spyOn(registry, 'resolveBackend');
    await runBootstrapCommand(options());
    expect(backend).not.toHaveBeenCalled();
    expect(messages.join('\n')).toContain('No surfaces were found');
  });
  it.each([
    { privacy: { localOnly: true }, code: 'inference-disabled-local-only' },
    { privacy: { allowedModels: ['allowed'] }, code: 'model-must-be-explicit' },
    { privacy: { allowedModels: ['allowed'] }, infer: { model: 'blocked' }, code: 'model-not-allowed' },
  ])('blocks inference under $code privacy policy', async ({ code, ...config }) => {
    await configuration(config);
    await expect(runBootstrapCommand(options())).rejects.toMatchObject({ code });
  });
  it.each([
    { localOnly: false, allowedAgents: ['claude'] }, { localOnly: true, allowedAgents: ['claude'] }, { localOnly: false, allowedAgents: ['codex'] },
  ])('reports availability and privacy allowlists on a dry run %j', async (privacy) => {
    await configuration({ privacy, surfaces: { overrides: [{ id: 'custom', kind: 'job', include: ['app/page.tsx'], title: 'Custom' }, { id: 'other', kind: 'job', include: ['other/**'] }] } });
    vi.spyOn(registry, 'probeBackends').mockResolvedValue([
      { id: 'claude', name: 'Claude', available: true, setupHint: 'Install Claude' },
      { id: 'codex', name: 'Codex', available: false, setupHint: 'Install Codex' },
      { id: 'api', name: 'API', available: false, setupHint: 'Install SDK' },
    ]);
    await runBootstrapCommand({ ...options(), dryRun: true });
    expect(messages.join('\n')).toContain('Available backends');
    expect(messages.join('\n')).toContain('no model was called');
  });
});

describe('incremental index output modes', () => {
  it('reports fresh, cached, dry, and changed indexes without losing source nodes', async () => {
    await runIndexGraphCommand({ ...options(), dryRun: true });
    await runIndexGraphCommand({ ...options(), dryRun: true, json: true });
    expect(JSON.parse(outputs.pop()!).cacheHit).toBe(false);
    await runIndexGraphCommand(options());
    await runIndexGraphCommand(options());
    await runIndexGraphCommand({ ...options(), dryRun: true });
    await runIndexGraphCommand({ ...options(), dryRun: true, json: true });
    expect(JSON.parse(outputs.pop()!).cacheHit).toBe(true);
    await fs.rm(path.join(root, '.docgen/cache/.gitignore'));
    await runIndexGraphCommand({ ...options(), json: true });
    expect(JSON.parse(outputs.pop()!).cacheIgnoreCreated).toBe(true);
    await write('app/page.tsx', 'export default function Home() { return "change"; }');
    await runIndexGraphCommand(options());
    expect(messages.join('\n')).toContain('cached');
    expect(JSON.parse(await fs.readFile(path.join(root, DEFAULT_GRAPH_INDEX), 'utf8')).nodes.some((node: { id: string }) => node.id === 'file:app/page.tsx')).toBe(true);
  });
});

describe('operational diagnostics and policy output', () => {
  it('applies and rolls back a legacy feature schema in both output modes', async () => {
    const record = { id: 'home', title: 'Home', aliases: [], status: 'active', owners: ['owner'], criticality: 'medium', selectors: { files: ['app/**'], nodes: [] }, recordedBy: 'owner', recordedAt: '2026-09-30T00:00:00Z' };
    const before = JSON.stringify(record);
    await write('docs/.features/home.json', before);
    await runMigrateCommand(options());
    expect(messages.join('\n')).toContain('upgraded with backups');
    const receipts = await fs.readdir(path.join(root, MIGRATIONS_DIR));
    const receiptFile = receipts[0]!;
    const receipt = JSON.parse(await fs.readFile(path.join(root, MIGRATIONS_DIR, receiptFile, 'receipt.json'), 'utf8'));
    await runMigrateCommand({ ...options(), rollback: receipt.id, json: true });
    expect(await fs.readFile(path.join(root, 'docs/.features/home.json'), 'utf8')).toBe(before);
    await runMigrateCommand({ ...options(), json: true });
    const applied = JSON.parse(outputs.pop()!);
    await runMigrateCommand({ ...options(), rollback: applied.id });
    expect(messages.join('\n')).toContain('Rolled back');
  });
  it('reports unsupported runtimes, invalid configuration, schemas, and caches', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
    Object.defineProperty(process.versions, 'node', { ...descriptor, value: '20.10.0' });
    try { await expect(runDoctorCommand(options())).rejects.toMatchObject({ code: 'doctor-failed' }); }
    finally { Object.defineProperty(process.versions, 'node', descriptor); }
    await write('docgen.config.json', '{bad');
    await write('docs/.features/future.json', '{"schemaVersion":99}');
    await write(DEFAULT_GRAPH_INDEX, '{bad');
    await expect(runDoctorCommand({ ...options(), configFile: 'docgen.config.json', json: true })).rejects.toMatchObject({ code: 'doctor-failed' });
    const report = JSON.parse(outputs.pop()!);
    expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'config', status: 'fail' }), expect.objectContaining({ id: 'cache', status: 'warn' }), expect.objectContaining({ id: 'schemas', status: 'fail' })]));
  });
  it('prints policy failures, honors an owned exception, and exposes strict question gates', async () => {
    await seedGovernance(root);
    await configuration({ governance: { policies: { criticalFeaturesRequireVerification: true }, criticalityAtLeast: 'high' } });
    await expect(runPolicyCheckCommand(options())).rejects.toMatchObject({ code: 'governance-policy-failed' });
    expect(messages.join('\n')).toContain('fail');
    await runPolicyExceptionAddCommand({ ...options(), id: 'review-pending', policy: 'critical-feature-verification', subject: 'home', owner: 'owner', reason: 'Review scheduled', expiresAt: '2027-01-01T00:00:00Z', recordedAt: '2026-09-30T00:00:00Z' });
    await runPolicyCheckCommand({ ...options(), asOf: '2026-09-30T00:00:00Z' });
    expect(messages.join('\n')).toContain('exception review-pending');
    await runSyncCommand(options());
    await expect(runCheckCommand({ ...options(), strict: true, json: true })).rejects.toMatchObject({ code: 'unresolved-questions' });
    expect(JSON.parse(outputs.pop()!).ok).toBe(false);
  });
  it('reports missing, changed, orphaned, and more than forty drifted generated pages', async () => {
    await runSyncCommand(options());
    const cards = Array.from({ length: 41 }, (_, index): FeatureCard => ({ ...homeCard(), surfaceId: `screen:/route${index}`, slug: `route${index}`, body: { ...homeCard().body, summary: { text: 'Page', evidence: [{ file: `app/route${index}/page.tsx`, line: 1 }] } } }));
    for (let index = 0; index < 41; index++) await write(`app/route${index}/page.tsx`, `export default function Route${index}() { return null; }`);
    await saveCards(root, cards);
    await write('docs/generated/index.md', 'changed');
    await write('docs/generated/behaviour/orphan.md', 'orphan');
    await expect(runCheckCommand(options())).rejects.toMatchObject({ code: 'documentation-drift' });
    expect(messages.join('\n')).toContain('and');
    expect(messages.join('\n')).toContain('missing');
    expect(messages.join('\n')).toContain('orphaned');
  });
  it('reports dangling trace citations and untraced surfaces', async () => {
    await saveCards(root, [homeCard()]);
    await write('tests/home.test.ts', '// REQ-home-99\n');
    await runTraceCommand(options());
    expect(messages.join('\n')).toContain('unknown');
    expect(messages.join('\n')).toContain('nothing written');
    await expect(runTraceCommand({ ...options(), strict: true })).rejects.toMatchObject({ code: 'traceability-gaps' });
  });
});

describe('static extraction stack and findings output', () => {
  it('prints disabled extractors, unsupported stacks, and default configuration without Git', async () => {
    await configuration({ extractors: { routes: false } });
    await write('requirements.txt', 'Django==5.0\nFlask==3.0\n');
    await write('Gemfile', "gem 'rails', '8.0'\n");
    await write('.gitignore', 'ignored/**\n!ignored/keep.ts\n');
    await runExtractCommand({ ...options(), json: false, dryRun: true });
    await runReportCommand({ ...options(), json: false });
    await runReportCommand({ ...options(), json: true });
    await runStatusCommand(options());
    expect(messages.join('\n')).toContain('disabled');
    expect(messages.join('\n')).toContain('not run');
    await fs.rm(path.join(root, 'docgen.config.json'));
    await fs.rm(path.join(root, '.git'), { recursive: true });
    await runExtractCommand({ ...options(), json: false });
    expect(messages.join('\n')).toContain('defaults');
    expect(messages.join('\n')).toContain('Git metadata unavailable');
  });
});
