import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { runExtraction } from '../src/pipeline.js';
import { createLogger } from '../src/util/logger.js';
import { ensureGitattributes, renderAll, writeAll } from '../src/render/index.js';
import { recordRequirement } from '../src/requirements/store.js';
import { renderRequirementsPage } from '../src/requirements/render.js';
import { scanTestReferences } from '../src/trace/scan.js';
import { enrichGraphWithPythonSymbols, computeGovernanceFiles } from '../src/index.js';
import { featureCardSchema } from '../src/infer/types.js';
import { saveCards } from '../src/infer/store.js';
import { renderBehaviourIndex } from '../src/infer/behaviour.js';
import { assertGeneratedPath } from '../src/util/generated.js';
import { collectStatus } from '../src/status/collect.js';
import { featureRecordSchema } from '../src/features/schema.js';
import { writeNewFeatureRecord } from '../src/features/store.js';
import { evaluatePilot } from '../src/pilot/evaluate.js';
import { findDrift } from '../src/verify/expected.js';
import { renderReadme } from '../src/render/pages/readme.js';
import { renderRoutesPage } from '../src/render/pages/routes.js';
import type { RoutesResult } from '../src/types/entries.js';
import { writeNewPlanRecord } from '../src/plans/store.js';
import { planRecordSchema } from '../src/plans/schema.js';

const roots: string[] = [];
async function repo(files: Record<string, string> = {}) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-core-integration-')); roots.push(root); for (const [file, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); } return root; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('documentation lane integration and I/O failures', () => {
  it('exports lazy Python enrichment and links existing human requirement files', async () => {
    const root = await repo({ 'app/page.tsx': 'export default function Home() { return null; }', 'package.json': JSON.stringify({ dependencies: { next: '1' } }) });
    const config = await loadConfig({ root });
    const run = await runExtraction({ config, logger: createLogger({ level: 'silent' }) });
    expect(await enrichGraphWithPythonSymbols({ root, graph: run.graph, exclude: [] })).toEqual(run.graph);
    await recordRequirement({ root, surfaceId: 'screen:/', slug: 'home', kind: 'requirement', title: 'Home', statement: 'Home loads', questionId: 'q', recordedBy: 'owner', recordedAt: '' });
    expect((await writeAll(run)).written).toContain('docs/generated/README.md');
    expect(await fs.readFile(path.join(root, 'docs/generated/README.md'), 'utf8')).toContain('requirements.md');
    await fs.writeFile(path.join(root, '.gitattributes'), 'other/** text');
    await expect(ensureGitattributes(root, 'docs/generated')).resolves.toBe(true);
    expect(await fs.readFile(path.join(root, '.gitattributes'), 'utf8')).toContain('other/** text\ndocs/generated/**');
  });
  it('propagates inaccessible generated behavior index while leaving source files intact', async () => {
    const root = await repo({ 'app/page.tsx': 'export default function Home() { return null; }', 'package.json': JSON.stringify({ dependencies: { next: '1' } }) });
    const config = await loadConfig({ root });
    const run = await runExtraction({ config, logger: createLogger({ level: 'silent' }) });
    const read = fs.readFile.bind(fs);
    const denied = Object.assign(new Error('access denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'readFile').mockImplementation(async (file, ...options: Parameters<typeof fs.readFile> extends [unknown, ...infer R] ? R : never) => {
      if (String(file).endsWith(`${path.sep}behaviour.md`)) throw denied;
      return read(file, ...options);
    });
    await expect(writeAll(run)).rejects.toBe(denied);
    expect(await fs.readFile(path.join(root, 'app/page.tsx'), 'utf8')).toContain('Home');
  });
  it('renders configured override titles, unsupported README evidence and card singular counts', async () => {
    const root = await repo({ 'app/page.tsx': 'export default function Home() { return null; }', 'package.json': JSON.stringify({ dependencies: { next: '1', fastify: '1' } }), 'docgen.config.json': JSON.stringify({ surfaces: { overrides: [{ id: 'custom', title: 'Custom title', kind: 'screen', include: ['app/page.tsx'] }] } }) });
    const run = await runExtraction({ config: await loadConfig({ root }), logger: createLogger({ level: 'silent' }) });
    expect(renderAll(run).find(file => file.path.endsWith('/README.md'))?.contents).toContain('Fastify');
    const body = featureCardSchema.parse({ summary: { text: 'Home', evidence: [{ file: 'app/page.tsx', line: 1 }] }, unknowns: [{ id: 'q', question: 'Intent?', why: 'Not known' }] });
    const card = { surfaceId: 'screen:/', slug: 'home', title: 'Home', kind: 'screen', body, producedBy: 'test', inputHash: '', promptVersion: '', answered: [] };
    await saveCards(root, [card]);
    expect(renderBehaviourIndex({ cards: [card], answers: new Map(), context: run.context, outDir: 'docs/generated' })).toContain('1 open question across 1 surface');
  });
  it('renders dispute notes with absent recorded dates and tolerates disappearing test files', async () => {
    const root = await repo({ 'a.test.ts': 'REQ-a-01\nREQ-a-01\n' });
    const requirement = { id: 'REQ-a-01', kind: 'requirement' as const, status: 'disputed' as const, title: 'A', statement: 'A', questionId: 'q', surfaceId: 'a', recordedBy: 'owner', recordedAt: '', note: 'Review note' };
    expect(renderRequirementsPage({ requirements: new Map([['a', { surfaceId: 'a', slug: 'a', requirements: [requirement] }]]), context: { engineVersion: 'test' }, pendingCount: 0 })).toContain('Review note');
    expect((await scanTestReferences({ root, globs: ['*.test.ts'] })).map(ref => ref.line)).toEqual([1, 2]);
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('disappeared'));
    expect(await scanTestReferences({ root, globs: ['*.test.ts'] })).toEqual([]);
  });
  it('rejects repository-root output paths before touching the filesystem', async () => {
    const root = await repo();
    await expect(assertGeneratedPath(root, '.')).rejects.toMatchObject({ code: 'generated-path-outside-root' });
  });
  it('collects configured surfaces when the endpoint and jobs extractors are disabled', async () => {
    const root = await repo({ 'a.ts': 'export function run() { return true; }', 'app/page.tsx': 'export default function Home() { return null; }', 'package.json': JSON.stringify({ dependencies: { next: '1', fastify: '1' } }), 'docgen.config.json': JSON.stringify({ extractors: { endpoints: false, jobs: false }, surfaces: { overrides: [{ id: 'custom', title: 'Title', kind: 'screen', include: ['app/page.tsx'] }, { id: 'helper', kind: 'screen', include: ['a.ts'] }] } }) });
    await writeNewFeatureRecord(root, featureRecordSchema.parse({ schemaVersion: 1, id: 'a', title: 'A', criticality: 'critical', selectors: { files: ['a.ts'] }, recordedBy: 'owner', recordedAt: '2026-01-01T00:00:00.000Z' }));
    const status = await collectStatus({ cwd: root, logger: createLogger({ level: 'silent' }) });
    expect(status.graph.criticalFeatures).toBe(1);
    expect(status.surfaces).toBe(1);
    expect(renderAll(await runExtraction({ config: await loadConfig({ root }), logger: createLogger({ level: 'silent' }) }))).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'docs/generated/README.md' })]));
  });
  it('reports detected unsupported technologies from attributed pilot manifests', async () => {
    const root = await repo({ 'package.json': JSON.stringify({ dependencies: { fastify: '1' } }), 'docgen.pilot.json': JSON.stringify({ schemaVersion: 1, repository: 'test', repositoryClass: 'backend', reviewStatus: 'draft', reviewedBy: 'owner', reviewedAt: '2026-01-01T00:00:00.000Z', expectations: { technologies: [], graphGaps: [] } }) });
    const report = await evaluatePilot({ root, logger: createLogger({ level: 'silent' }) });
    expect(report.observed.unsupportedTechnologies).toContain('fastify');
    const run = await runExtraction({ config: await loadConfig({ root }), logger: createLogger({ level: 'silent' }) });
    const unsupported = run.stack.unsupported.map(({ unsupportedNote: _note, ...technology }) => technology);
    expect(renderReadme({ ...run, stack: { ...run.stack, unsupported } })).toContain('Fastify');
  });
  it('renders an explicit route component source instead of the router declaration source', async () => {
    const root = await repo({ 'app/page.tsx': 'export default function Home() { return null; }', 'package.json': JSON.stringify({ dependencies: { next: '1' } }) });
    const run = await runExtraction({ config: await loadConfig({ root }), logger: createLogger({ level: 'silent' }) });
    const routes = run.results.get('routes') as RoutesResult;
    const result = { ...routes, entries: routes.entries.map(entry => ({ ...entry, component: { file: 'Home.tsx', line: 4 } })) };
    expect(renderRoutesPage({ result, stack: run.stack, context: run.context, outDir: 'docs/generated' })).toContain('Home.tsx:4');
  });
  it('ignores generated files behind junctions while detecting an ordinary orphan', async () => {
    const root = await repo({ 'elsewhere/generated.md': '<!-- docgen:generated -->\n# Elsewhere', 'docs/generated/orphan.md': '<!-- docgen:generated -->\n# Orphan' });
    await fs.symlink(path.join(root, 'elsewhere'), path.join(root, 'docs/generated/junction'), 'junction');
    expect(await findDrift(root, 'docs/generated', [])).toEqual([{ file: 'docs/generated/orphan.md', kind: 'orphaned' }]);
  });
  it('renders a newly recorded plan independently of the earlier extraction snapshot', async () => {
    const root = await repo({ 'package.json': '{"name":"snapshot"}' });
    const run = await runExtraction({ config: await loadConfig({ root }), logger: createLogger({ level: 'silent' }) });
    const source = await writeNewPlanRecord(root, planRecordSchema.parse({ schemaVersion: 1, id: 'new-plan', featureId: 'pending-feature', title: 'New plan', summary: 'Intent recorded after extraction.', recordedBy: 'owner', recordedAt: '2026-01-01T00:00:00.000Z' }));
    const before = await fs.readFile(path.join(root, source), 'utf8');
    const files = await computeGovernanceFiles(run);
    expect(files.some(file => file.path.endsWith('/features.md'))).toBe(false);
    expect(files.find(file => file.path.endsWith('/plans/new-plan.md'))?.contents).toContain('Recorded by: owner');
    await expect(fs.readFile(path.join(root, source), 'utf8')).resolves.toBe(before);
  });
});
