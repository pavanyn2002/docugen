import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHandoffCommand } from '../src/commands/handoff.js';
import { runExtractCommand } from '../src/commands/extract.js';
import { runReportCommand } from '../src/commands/report.js';
import { runStatusCommand } from '../src/commands/status.js';
import { runSyncCommand } from '../src/commands/sync.js';
import { runDoctorCommand } from '../src/commands/doctor.js';
import { runFleetCommand } from '../src/commands/fleet.js';
import { runTraceCommand } from '../src/commands/trace.js';
import { runPolicyCheckCommand } from '../src/commands/policy.js';
import { runChangeRecordCommand } from '../src/commands/change.js';
import { runFeatureAddCommand } from '../src/commands/feature.js';
import { runPlanStatusCommand } from '../src/commands/plan.js';
import { runGraphSearchCommand, runGraphExplainCommand } from '../src/commands/query-graph.js';
import { runBootstrapCommand } from '../src/commands/bootstrap.js';
import { runSecurityScanCommand } from '../src/commands/security.js';
import { runAnswerCommand } from '../src/commands/answer.js';
import { runTriageCommand } from '../src/commands/triage.js';
import { runInitCommand } from '../src/commands/init.js';
import { runIndexGraphCommand } from '../src/commands/index-graph.js';
import * as registry from '../src/agents/registry.js';
import { saveCards } from '../src/infer/store.js';
import { recordRequirement } from '../src/requirements/store.js';
import { loadChangeRecords } from '../src/changes/store.js';
import type { Logger } from '../src/util/logger.js';
import type { FeatureCard } from '../src/infer/types.js';
import { createRepository, homeCard, seedGovernance } from './helpers/repository.js';

let root: string;
const messages: string[] = [];
const outputs: string[] = [];
const logger: Logger = { level: 'debug', error: (s) => messages.push(s), warn: (s) => messages.push(s), info: (s) => messages.push(s), debug: (s) => messages.push(s), heading: (s) => messages.push(s), output: (s) => outputs.push(s) };
const options = () => ({ cwd: root, logger });
async function write(file: string, contents: string) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), contents); }
async function config(value: Record<string, unknown>) { await write('docgen.config.json', JSON.stringify({ include: ['**/*'], ...value })); }
beforeEach(async () => { root = await createRepository(); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); messages.length = 0; outputs.length = 0; await fs.rm(root, { recursive: true, force: true }); });

describe('remaining documented command modes', () => {
  it('prints unsupported technology gaps for one and multiple frameworks', async () => {
    await config({});
    await write('package.json', JSON.stringify({ dependencies: { fastify: '^5' } }));
    await runExtractCommand({ ...options(), json: false, dryRun: true });
    await runReportCommand({ ...options(), json: false });
    await runReportCommand({ ...options(), json: true });
    await runStatusCommand(options());
    expect(messages.join('\n')).toContain('cannot parse Fastify');
    expect(messages.join('\n')).toContain('1 detected technology');
    expect(JSON.parse(outputs.pop()!).unsupported).toMatchObject([{ id: 'fastify', note: expect.any(String) }]);
    await write('package.json', JSON.stringify({ dependencies: { fastify: '^5', '@medusajs/medusa': '^2' } }));
    await runExtractCommand({ ...options(), json: false, dryRun: true });
    await runReportCommand({ ...options(), json: false });
    expect(messages.join('\n')).toContain('2 detected technologies');
  });

  it('prints multiple workspace ownership labels and an empty selected extraction', async () => {
    await config({});
    await write('package.json', JSON.stringify({ name: 'workspace', private: true, workspaces: ['packages/*'] }));
    await write('packages/app/package.json', JSON.stringify({ name: 'app', dependencies: { next: '^15' } }));
    await write('packages/app/app/page.tsx', 'export default function Page() { return null; }');
    await runExtractCommand({ ...options(), json: false, dryRun: true });
    expect(messages.join('\n')).toContain('workspaces');
    expect(messages.join('\n')).toContain('in packages/app/');
    await config({ extractors: { routes: false, deps: false, schema: false, endpoints: false, jobs: false, config: false } });
    await runExtractCommand({ ...options(), json: false, dryRun: true });
    await runReportCommand({ ...options(), json: true });
    expect(JSON.parse(outputs.pop()!).coverage.every((entry: { applicable: boolean }) => entry.applicable === false)).toBe(true);
  });

  it('reports an empty undetected stack and truncates findings while preserving full output', async () => {
    await config({});
    await write('package.json', '{}');
    await fs.rm(path.join(root, 'app'), { recursive: true });
    for (let index = 0; index < 12; index++) await write(`src/unused${index}.ts`, `export const unused${index} = ${index};`);
    await runExtractCommand({ ...options(), json: false, dryRun: true });
    await runReportCommand({ ...options(), json: false });
    expect(messages.join('\n')).toContain('2 more (use --full)');
    await runReportCommand({ ...options(), json: false, full: true });
    expect(messages.join('\n')).toContain('src/unused11.ts');
  });

  it('reports no findings when the repository contains no source modules', async () => {
    await write('package.json', '{}');
    await fs.rm(path.join(root, 'app'), { recursive: true });
    await runReportCommand({ ...options(), json: false });
    expect(messages.join('\n')).toContain('Nothing to report');
  });

  it('reports supported configuration findings and renders source locations', async () => {
    await config({});
    await write('.env.example', 'UNUSED_SETTING=fixture\n');
    await write('app/settings.ts', 'export const value = process.env.UNDECLARED_SETTING;');
    await runReportCommand({ ...options(), json: false });
    await runReportCommand({ ...options(), json: true });
    expect(messages.join('\n')).toContain('UNUSED_SETTING');
    expect(messages.join('\n')).toContain('.env.example');
    expect(JSON.parse(outputs.pop()!).findings.some((finding: { items: Array<{ line: number | null }> }) => finding.items.some((item) => typeof item.line === 'number'))).toBe(true);
  });

  it('reports unsupported supply-chain formats through readable diagnostics', async () => {
    await write('yarn.lock', '# Yarn lock');
    await runSecurityScanCommand(options());
    expect(messages.join('\n')).toContain('unsupported-manifest: yarn.lock');
  });

  it('previews bootstrap with disabled input extractors and counts existing answers', async () => {
    await saveCards(root, [homeCard()]);
    await runAnswerCommand({ ...options(), surface: 'home', questionId: 'access', answer: 'Everyone' });
    await config({ extractors: { routes: false, endpoints: false, jobs: false }, surfaces: { overrides: [{ id: 'manual', kind: 'job', include: ['app/**'] }] } });
    vi.spyOn(registry, 'probeBackends').mockResolvedValue([]);
    await runBootstrapCommand({ ...options(), dryRun: true });
    expect(messages.join('\n')).toContain('No surfaces were found');
    await config({ extractors: { endpoints: false, jobs: false } });
    await runBootstrapCommand({ ...options(), dryRun: true });
    expect(messages.join('\n')).toContain('answers   1 on record');
  });

  it('records unknown Git attribution for a valid governed change', async () => {
    await seedGovernance(root);
    execFileSync('git', ['config', '--unset', 'user.email'], { cwd: root, windowsHide: true });
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'missing-config')); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    await write('app/page.tsx', 'export default function Home() { return "updated"; }');
    await runChangeRecordCommand({ ...options(), id: 'change', summary: 'Update', features: 'home' });
    expect((await loadChangeRecords(root))[0]?.recordedBy).toBe('unknown');
  });

  it('lists a policy report for an explicit change base', async () => {
    await runPolicyCheckCommand({ ...options(), base: 'HEAD', json: true });
    expect(JSON.parse(outputs.pop()!).ok).toBe(true);
  });

  it('generates a dry handoff and protects output boundaries and unwritable destinations', async () => {
    await seedGovernance(root);
    await runPlanStatusCommand({ ...options(), id: 'home-update', status: 'approved' });
    await runPlanStatusCommand({ ...options(), id: 'home-update', status: 'in-progress' });
    await write('app/page.tsx', 'export default function Home() { return "updated"; }');
    await runHandoffCommand({ ...options(), dryRun: true });
    expect(messages.join('\n')).toContain('would write');
    await runPlanStatusCommand({ ...options(), id: 'home-update', status: 'completed' });
    await runHandoffCommand({ ...options(), dryRun: true, json: true });
    expect(JSON.parse(outputs.pop()!).plans).toBe(1);
    await expect(runHandoffCommand({ ...options(), out: '../outside.md' })).rejects.toMatchObject({ code: 'handoff-outside-root' });
    await write('blocked', 'File');
    await expect(runHandoffCommand({ ...options(), out: 'blocked/handoff.md' })).rejects.toMatchObject({ code: 'handoff-write-failed' });
  });

  it('keeps feature history optional when selected code has not been committed', async () => {
    await write('app/new.ts', 'export const newCode = 1;');
    await runFeatureAddCommand({ ...options(), id: 'new', title: 'New', files: 'app/new.ts' });
    await runHandoffCommand({ ...options(), json: true });
    expect(JSON.parse(outputs.pop()!).affectedFeatures).toBe(1);
  });

  it('prints more than twenty generated page writes and then an unchanged sync', async () => {
    const cards = Array.from({ length: 22 }, (_, index): FeatureCard => ({ ...homeCard(), surfaceId: `screen:/route${index}`, slug: `route${index}`, body: { ...homeCard().body, summary: { text: 'Page', evidence: [{ file: `app/route${index}/page.tsx`, line: 1 }] } } }));
    for (let index = 0; index < 22; index++) await write(`app/route${index}/page.tsx`, `export default function Page${index}() { return null; }`);
    await saveCards(root, cards);
    await runSyncCommand({ ...options(), dryRun: true });
    expect(messages.join('\n')).toContain('more');
    await runSyncCommand(options());
    await runSyncCommand(options());
    expect(messages.join('\n')).toContain('already up to date');
  });

  it('renders an untested requirement and written traceability artifacts', async () => {
    await saveCards(root, [homeCard()]);
    await recordRequirement({ root, surfaceId: 'screen:/', slug: 'home', kind: 'requirement', title: 'Home works', statement: 'Home works', questionId: 'access', recordedBy: 'reviewer', recordedAt: '2026-09-30T00:00:00Z' });
    await runTraceCommand(options());
    await runTraceCommand({ ...options(), json: true });
    expect(messages.join('\n')).toContain('untested  REQ-home-01');
    expect(messages.join('\n')).toContain('written to');
    expect(JSON.parse(outputs.pop()!).untested).toEqual(['REQ-home-01']);
  });

  it('reports approved optional pilot evidence', async () => {
    await write('docgen.pilot.json', JSON.stringify({ schemaVersion: 1, repository: 'fixture', repositoryClass: 'frontend', reviewStatus: 'approved', reviewedBy: 'maintainer', reviewedAt: '2026-09-30T00:00:00Z', expectations: { technologies: [], graphGaps: [] } }));
    await runDoctorCommand(options());
    expect(messages.join('\n')).toContain('Pilot evidence is approved by maintainer');
  });

  it('diagnoses a config read failure separately from validation errors', async () => {
    const nativeRead = fs.readFile;
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === path.join(root, 'docgen.config.json')) throw Object.assign(new Error('Read permission denied'), { code: 'EACCES' });
      return nativeRead(...args);
    });
    await expect(runDoctorCommand(options())).rejects.toMatchObject({ code: 'doctor-failed' });
    expect(messages.join('\n')).toContain('Repair the configuration');
  });

  it('renders graph evidence without line metadata for external package nodes', async () => {
    await config({});
    await write('app/page.tsx', 'import React from "react"; export default function Home() { return React; }');
    await runGraphSearchCommand({ ...options(), text: 'react', json: true });
    const nodes = JSON.parse(outputs.pop()!).nodes as Array<{ id: string; kind: string }>;
    const packageNode = nodes.find((node) => node.kind === 'package');
    expect(packageNode).toBeDefined();
    await runGraphExplainCommand({ ...options(), id: packageNode!.id });
    expect(messages.join('\n')).toContain('evidence');
  });

  it('updates an installed adapter while preserving unrelated instruction text', async () => {
    await runInitCommand({ ...options(), all: true });
    const installed = path.join(root, 'AGENTS.md');
    const original = await fs.readFile(installed, 'utf8');
    await fs.writeFile(installed, `# Human instructions\n${original.replace('session start', 'old session start')}`);
    await runInitCommand({ ...options(), all: true });
    expect(messages.join('\n')).toContain('updated');
    expect(await fs.readFile(installed, 'utf8')).toContain('# Human instructions');
  });

  it('recreates the graph cache ignore file on a cached readable index run', async () => {
    await runIndexGraphCommand(options());
    await fs.rm(path.join(root, '.docgen/cache/.gitignore'));
    await runIndexGraphCommand(options());
    expect(messages.join('\n')).toContain('created cache-local .gitignore');
  });

  it('writes a fleet dashboard using its default filename', async () => {
    const cwd = process.cwd();
    const nativeCwd = process.cwd;
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      await runFleetCommand({ paths: [root], logger });
      expect(await fs.readFile(path.join(root, 'docgen-fleet.md'), 'utf8')).toContain('Documentation across');
    } finally { vi.mocked(process.cwd).mockImplementation(nativeCwd); }
    expect(process.cwd()).toBe(cwd);
  });

  it('requires a terminal for interactive triage with pending answers', async () => {
    await saveCards(root, [homeCard()]);
    await runAnswerCommand({ ...options(), surface: 'home', questionId: 'access', answer: 'Everyone' });
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    try { await expect(runTriageCommand(options())).rejects.toMatchObject({ code: 'not-interactive' }); }
    finally { if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor); else Reflect.deleteProperty(process.stdin, 'isTTY'); }
  });

  it('reports known question ids when an unknown question is requested', async () => {
    await saveCards(root, [homeCard()]);
    await expect(runAnswerCommand({ ...options(), surface: 'missing', questionId: 'missing', answer: 'yes' })).rejects.toMatchObject({ remedy: 'Known surfaces: home' });
    await expect(runAnswerCommand({ ...options(), surface: 'home', questionId: 'missing', answer: 'yes' })).rejects.toMatchObject({ remedy: 'Its question ids are: access, empty' });
  });
});
