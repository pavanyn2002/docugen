import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { loadFeatureRecords } from '../src/features/store.js';
import { loadPlanRecords } from '../src/plans/store.js';
import { loadChangeRecords } from '../src/changes/store.js';
import { loadAnswers } from '../src/questions/store.js';
import * as registry from '../src/agents/registry.js';
import { createRepository, seedGovernance } from './helpers/repository.js';

let root: string;
const output: string[] = [];
const diagnostics: string[] = [];

beforeEach(async () => {
  root = await createRepository();
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { diagnostics.push(String(chunk)); return true; });
});

afterEach(async () => {
  vi.restoreAllMocks();
  output.length = 0;
  diagnostics.length = 0;
  await fs.rm(root, { recursive: true, force: true });
});

async function invoke(args: string[], config = false): Promise<{ code: number; stdout: string; stderr: string }> {
  output.length = 0;
  diagnostics.length = 0;
  const code = await main(['node', 'docgen', '--cwd', root, '--no-color',
    ...(config ? ['--config', 'docgen.config.json', '--verbose'] : []), ...args]);
  return { code, stdout: output.join(''), stderr: diagnostics.join('') };
}

describe('CLI read and generation workflows', () => {
  it.each([
    { args: ['status', '--json'], expected: { described: 0, surfaces: 1 } },
    { args: ['feature', 'list', '--json'], expected: { count: 0, features: [] } },
    { args: ['plan', 'list', '--json'], expected: { count: 0, plans: [] } },
    { args: ['policy', 'check', '--json'], expected: { ok: true, violations: [] } },
    { args: ['policy', 'exception', 'list', '--json'], expected: { count: 0, exceptions: [] } },
    { args: ['sync', '--dry-run', '--json'], expected: { dryRun: true, deleted: [] } },
  ])('executes $args with structured output', async ({ args, expected }) => {
    const result = await invoke(args);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject(expected);
  });

  it.each([
    { args: ['status'], text: 'Next: `docgen sync`' },
    { args: ['feature', 'list'], text: 'none registered' },
    { args: ['plan', 'list'], text: 'none recorded' },
    { args: ['policy', 'check'], text: 'Governance policies' },
    { args: ['policy', 'exception', 'list'], text: 'Governance exceptions (0)' },
    { args: ['ask'], text: 'No feature cards exist' },
    { args: ['triage', '--list'], text: 'triage' },
  ])('executes $args with an explicit config and readable diagnostics', async ({ args, text }) => {
    const result = await invoke(args, true);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr.toLowerCase()).toContain(text.toLowerCase());
  });

  it('honors custom graph output, query filters, and an identity path', async () => {
    const indexed = await invoke(['index', '--out', '.docgen/custom.json', '--no-symbols', '--json'], true);
    expect(indexed.code, indexed.stderr).toBe(0);
    const graph = JSON.parse(await fs.readFile(path.join(root, '.docgen/custom.json'), 'utf8'));
    expect(graph.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'file:app/page.tsx' })]));
    const search = await invoke(['query', 'app/page.tsx', '--kinds', 'file', '--limit', '1', '--json'], true);
    expect(search.code, search.stderr).toBe(0);
    expect(search.stdout).toContain('file:app/page.tsx');
    const explained = await invoke(['explain', 'file:app/page.tsx', '--json'], true);
    expect(explained.code, explained.stderr).toBe(0);
    expect(explained.stdout).toContain('app/page.tsx');
    const found = await invoke(['path', 'file:app/page.tsx', 'file:app/page.tsx', '--direction', 'both', '--edge-kinds', 'imports', '--max-depth', '0', '--json'], true);
    expect(found.code, found.stderr).toBe(0);
    expect(JSON.parse(found.stdout)).toMatchObject({ found: true });
  });

  it('reports extraction, drift repair, and a clean strict gate through the CLI', async () => {
    const extracted = await invoke(['extract', '--only', 'routes,deps', '--out', 'docs/custom', '--dry-run', '--json'], true);
    expect(extracted.code, extracted.stderr).toBe(0);
    expect(JSON.parse(extracted.stdout)).toMatchObject({ outDir: 'docs/custom', written: [] });
    expect((await invoke(['sync', '--json'])).code).toBe(0);
    const checked = await invoke(['check', '--base', 'HEAD', '--as-of', '2026-09-30T00:00:00Z', '--strict', '--json'], true);
    expect(checked.code, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout)).toMatchObject({ ok: true, drift: [] });
    const traced = await invoke(['trace', '--strict', '--json'], true);
    expect(traced.code, traced.stderr).toBe(0);
    expect(JSON.parse(traced.stdout)).toMatchObject({ testable: 0, tested: 0, untested: [] });
    const report = await invoke(['report', '--full', '--json'], true);
    expect(report.code, report.stderr).toBe(0);
    expect(report.stdout).toContain('routes');
  });

  it('previews bootstrap without invoking a model', async () => {
    vi.spyOn(registry, 'probeBackends').mockResolvedValue([]);
    const result = await invoke(['bootstrap', '--force', '--limit', '1', '--dry-run'], true);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain('Dry run');
    await expect(fs.stat(path.join(root, 'docs/.cards'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('CLI governed feature lifecycle', () => {
  it('preserves selectors, repeated acceptance criteria, and attributed transitions', async () => {
    const added = await invoke(['feature', 'add', 'home', '--title', 'Home', '--description', 'Landing page',
      '--aliases', 'landing', '--files', 'app/**', '--nodes', 'file:app/page.tsx', '--owners', 'dev@example.com',
      '--status', 'active', '--criticality', 'high', '--json'], true);
    expect(added.code, added.stderr).toBe(0);
    expect((await loadFeatureRecords(root))[0]).toMatchObject({ id: 'home', description: 'Landing page', aliases: ['landing'], owners: ['dev@example.com'] });
    const shown = await invoke(['feature', 'show', 'landing', '--json']);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('app/page.tsx');
    const created = await invoke(['plan', 'create', 'home-update', '--feature', 'landing', '--title', 'Update home',
      '--summary', 'Improve home', '--status', 'draft', '--acceptance', 'Loads successfully', '--acceptance', 'Links work',
      '--risk', 'Navigation', '--test-note', 'Check links', '--json'], true);
    expect(created.code, created.stderr).toBe(0);
    expect((await loadPlanRecords(root))[0]).toMatchObject({ featureId: 'home', acceptanceCriteria: [{ id: 'AC-01', text: 'Loads successfully' }, { id: 'AC-02', text: 'Links work' }], risks: ['Navigation'], testNotes: ['Check links'] });
    const transitioned = await invoke(['plan', 'status', 'home-update', 'approved', '--note', 'Ready to build', '--json'], true);
    expect(transitioned.code, transitioned.stderr).toBe(0);
    expect(JSON.parse(transitioned.stdout)).toMatchObject({ status: 'approved', transitions: [{ changedBy: 'dev@example.com', note: 'Ready to build' }] });
    const plan = await invoke(['plan', 'show', 'home-update'], true);
    expect(plan.code, plan.stderr).toBe(0);
    expect(plan.stderr).toContain('Loads successfully');
    expect(plan.stderr).toContain('Ready to build');
  });

  it('records changed files and writes a tester handoff using the requested base', async () => {
    await seedGovernance(root);
    await fs.writeFile(path.join(root, 'app/page.tsx'), 'export default function Home() { return "Updated"; }\n');
    const impact = await invoke(['impact', '--base', 'HEAD', '--max-depth', '3', '--limit', '2', '--json'], true);
    expect(impact.code, impact.stderr).toBe(0);
    expect(impact.stdout).toContain('app/page.tsx');
    const recorded = await invoke(['change', 'record', 'home-change', '--summary', 'Updated home', '--features', 'landing',
      '--plans', 'home-update', '--kind', 'fix', '--base', 'HEAD', '--json'], true);
    expect(recorded.code, recorded.stderr).toBe(0);
    expect((await loadChangeRecords(root))[0]).toMatchObject({ id: 'home-change', featureIds: ['home'], planIds: ['home-update'], kind: 'fix' });
    const handoff = await invoke(['handoff', '--base', 'HEAD', '--out', 'docs/handoffs/custom.md', '--max-depth', '3', '--json'], true);
    expect(handoff.code, handoff.stderr).toBe(0);
    expect(await fs.readFile(path.join(root, 'docs/handoffs/custom.md'), 'utf8')).toContain('app/page.tsx');
  });

  it('records numbered answers, lists pending triage, and retains the human note', async () => {
    await seedGovernance(root);
    const asked = await invoke(['ask', '--mine', '--surface', 'home', '--limit', '1', '--json'], true);
    expect(asked.code, asked.stderr).toBe(0);
    expect(JSON.parse(asked.stdout)).toMatchObject({ filteredBy: { mine: 'dev@example.com', surface: 'home' } });
    const answered = await invoke(['answer', 'home', 'access', '2', '--note', 'Authentication is required'], true);
    expect(answered.code, answered.stderr).toBe(0);
    expect((await loadAnswers(root)).get('screen:/')?.answers[0]).toMatchObject({ answer: 'Signed-in users', answeredBy: 'dev@example.com', note: 'Authentication is required' });
    const pending = await invoke(['triage', '--list', '--json']);
    expect(pending.code, pending.stderr).toBe(0);
    expect(pending.stdout).toContain('access');
    const triaged = await invoke(['triage', 'home', 'access', 'requirement', '--note', 'Confirmed access rule'], true);
    expect(triaged.code, triaged.stderr).toBe(0);
    expect(triaged.stderr).toContain('REQ-');
  });

  it.each([
    { args: ['feature', 'show', 'missing', '--json'], text: 'missing' },
    { args: ['plan', 'show', 'missing', '--json'], text: 'does not exist' },
    { args: ['plan', 'create', 'missing-plan', '--feature', 'missing', '--title', 'Missing', '--summary', 'No feature'], text: 'not registered' },
    { args: ['policy', 'check', '--as-of', 'invalid'], text: 'valid ISO-8601' },
    { args: ['path', 'a', 'b', '--direction', 'invalid'], text: 'direction' },
    { args: ['answer', 'missing', 'q1', 'answer'], text: 'No feature card' },
  ])('returns an actionable failure for $args', async ({ args, text }) => {
    const result = await invoke(args, true);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(text);
  });
});
