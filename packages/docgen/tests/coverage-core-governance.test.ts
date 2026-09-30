import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { featureRecordSchema } from '../src/features/schema.js';
import { planRecordSchema } from '../src/plans/schema.js';
import { changeRecordSchema } from '../src/changes/schema.js';
import { renderFeatureIndex, renderFeaturePage, renderPlanPage, renderChangelog } from '../src/governance/render.js';
import { scanSupplyChain } from '../src/security/scan.js';
import { buildCycloneDxBom } from '../src/security/sbom.js';
import { evaluateGovernanceAtRoot } from '../src/governance/evaluate.js';
import { evaluatePilot, renderPilotReport } from '../src/pilot/evaluate.js';
import { createLogger } from '../src/util/logger.js';
import { loadConfig } from '../src/config/load.js';
import { recordRequirement } from '../src/requirements/store.js';
import { writeNewFeatureRecord } from '../src/features/store.js';
import { saveCards } from '../src/infer/store.js';
import { featureCardSchema } from '../src/infer/types.js';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';
import { recordAnswer } from '../src/questions/store.js';
import { mapChangesIntoGraph } from '../src/changes/graph.js';
import { mapPlansIntoGraph } from '../src/plans/graph.js';
import { mapRequirementsIntoGraph } from '../src/requirements/graph.js';
import { addGovernanceException } from '../src/governance/store.js';

const roots: string[] = [];
const date = '2026-08-12T00:00:00.000Z';
async function repo(files: Record<string, string> = {}) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-core-governance-')); roots.push(root); for (const [file, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); } return root; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const context = { engineVersion: 'test', evidenceFingerprint: 'a'.repeat(64) };
const feature = { ...featureRecordSchema.parse({ schemaVersion: 1, id: 'a', title: 'A', aliases: ['alias'], owners: ['owner'], description: 'Description', recordedBy: 'owner', recordedAt: date }), sourceFile: 'docs/.features/a.json' };
const plan = { ...planRecordSchema.parse({ schemaVersion: 1, id: 'a', featureId: 'a', title: 'A', summary: 'Summary', recordedBy: 'owner', recordedAt: date }), sourceFile: 'docs/.plans/a.json' };
const change = { ...changeRecordSchema.parse({ schemaVersion: 1, id: 'a', kind: 'fix', summary: 'Summary', featureIds: ['a'], base: 'HEAD', files: [{ file: 'a.ts', status: 'modified' }], recordedBy: 'owner', recordedAt: date }), sourceFile: 'docs/.changes/a.json' };

describe('governed rendered histories', () => {
  it('renders known and unavailable commit histories and unassigned owners', () => {
    const history = { introduced: { sha: 'a'.repeat(40), committedAt: date }, lastChanged: { sha: 'b'.repeat(40), committedAt: date }, evidenceFiles: ['a.ts'] };
    const text = renderFeatureIndex({ features: [feature, { ...feature, id: 'b', owners: [] }], histories: new Map([['a', history]]), context });
    expect(text).toContain(date);
    expect(text).toContain('unassigned');
    const page = renderFeaturePage({ feature, history, nodes: [ { id: 'a', kind: 'file', label: 'A', provenance: { origin: 'extracted', evidence: [] } }, { id: 'b', kind: 'file', label: 'B', provenance: { origin: 'extracted', evidence: [{ file: 'b.ts' }] } }, { id: 'c', kind: 'file', label: 'C', provenance: { origin: 'extracted', evidence: [{ file: 'c.ts', line: 2 }] } } ], plans: [plan], changes: [change, { ...change, id: 'b', headDate: '2026-08-13T00:00:00.000Z' }], context });
    for (const expected of ['Description', '`alias`', 'b.ts', 'c.ts:2', 'plans/a.md', '2026-08-13']) expect(page).toContain(expected);
    expect(renderFeatureIndex({ features: [], histories: new Map(), context: { engineVersion: 'test' } })).toContain('No features');
    expect(renderFeaturePage({ feature: { ...feature, owners: [] }, nodes: [], plans: [], changes: [], context: { engineVersion: 'test' } })).toContain('unassigned');
    expect(renderFeaturePage({ feature, nodes: [], plans: [], changes: [change, { ...change, id: 'b' }], context })).toContain(date);
  });
  it('renders populated and empty plan lifecycle sections', () => {
    const populated = { ...plan, status: 'in-progress' as const, acceptanceCriteria: [{ id: 'AC-01', text: 'Criteria' }], risks: ['Risk'], testNotes: ['Tester'], transitions: [ { from: 'draft' as const, to: 'approved' as const, changedBy: 'owner', changedAt: date }, { from: 'approved' as const, to: 'in-progress' as const, changedBy: 'owner', changedAt: date, note: 'Reviewed' } ] };
    const text = renderPlanPage(populated, context);
    for (const expected of ['Criteria', 'Risk', 'Tester', 'Reviewed']) expect(text).toContain(expected);
    expect(renderPlanPage(plan, context)).toContain('No transition');
  });
  it('renders attributed change links, rename sources, tie dates and missing links', () => {
    const populated = { ...change, id: 'b', planIds: ['a'], surfaceIds: ['surface:a'], requirementIds: ['REQ-a-01'], testFiles: ['a.test.ts'], generatedPages: ['a.md'], headCommit: 'a'.repeat(40), headDate: date, files: [{ file: 'new.ts', status: 'renamed' as const, previousFile: 'old.ts' }] };
    const text = renderChangelog([populated, change, { ...change, id: 'c', recordedAt: '2026-08-11T00:00:00.000Z' }], context);
    for (const expected of ['`REQ-a-01`', '`a.test.ts`', '`a.md`', 'old.ts', 'uncommitted/unknown', '- Plans: none']) expect(text).toContain(expected);
    expect(renderChangelog([], context)).toContain('No governed changes');
  });
});

describe('supply chain provenance edge cases', () => {
  it('retains component identity without inventing a hash when buffer allocation fails', async () => {
    const root = await repo({ 'package.json': '{"dependencies":{"pkg":"1"}}', 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/pkg': { version: '1', integrity: 'sha256-YQ==' } } }) });
    const report = await scanSupplyChain(root);
    vi.spyOn(Buffer, 'from').mockImplementationOnce(() => { throw new RangeError('Buffer allocation failed'); });
    const bom = buildCycloneDxBom(report);
    expect(bom.components[0]).toMatchObject({ name: 'pkg', version: '1' });
    expect(bom.components[0]?.hashes).toBeUndefined();
  });
  it('inventories optional dependencies, malformed lock entries, duplicate versions and pending requirement continuations', async () => {
    const manifest = { dependencies: { shared: '^1' }, optionalDependencies: { optional: 'github:owner/repo' }, devDependencies: { shared: '^1', onlyDev: 'file:../dev' } };
    const packages = { '': {}, 'node_modules/': { version: '1' }, 'workspace/local': { version: '1' }, 'node_modules/unversioned': {}, 'node_modules/link': { version: '1', link: true }, 'node_modules/shared': { version: '1', dev: true }, 'node_modules/nested/node_modules/shared': { name: 'shared', version: '1', dev: false, resolved: 'https://registry.test/shared.tgz', integrity: 'sha256-YQ==', license: 'MIT' }, 'node_modules/shared2': { name: 'shared', version: '2' } };
    const root = await repo({ 'package.json': JSON.stringify(manifest), 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages }), 'requirements.txt': '--index-url https://example.test\n-e ./local\npkg==1 --hash=sha256:abc\nother==2 \\', 'pyproject.toml': '' });
    const report = await scanSupplyChain(root);
    expect(report.components.find(item => item.name === 'shared' && item.version === '1')).toMatchObject({ development: false, integrity: 'sha256-YQ==', license: 'MIT' });
    expect(report.components.filter(item => item.name === 'shared')).toHaveLength(2);
    expect(report.components.find(item => item.name === 'other')).toBeDefined();
    expect(report.gaps.map(gap => gap.kind)).toEqual(expect.arrayContaining(['unresolved-lock-entry', 'unsupported-manifest']));
    expect(report.findings.find(item => item.kind === 'python-requirement-unpinned')?.package).toBe('line-2');
    const bom = buildCycloneDxBom({ ...report, components: [ ...report.components, { ecosystem: 'npm', name: '@scope/name', version: '1', direct: true, development: false, sourceFile: 'lock', integrity: 'sha1-YQ==' }, { ecosystem: 'pypi', name: 'bad', version: '1', direct: false, development: true, sourceFile: 'lock', integrity: 'sha256-!!!!' }, { ecosystem: 'npm', name: 'unsupported-hash', version: '1', direct: false, development: false, sourceFile: 'lock', integrity: 'sha999-abc' } ] });
    expect(bom.components.find(item => item.name === '@scope/name')).toMatchObject({ purl: 'pkg:npm/%40scope/name@1', hashes: [{ alg: 'SHA-1', content: '61' }] });
    expect(bom.components.find(item => item.name === 'bad')?.hashes).toBeUndefined();
  });
  it('requires explicit workspace membership for ancestor locks', async () => {
    const root = await repo({ 'package.json': JSON.stringify({ workspaces: { packages: ['packages/*'] } }), 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {} }), 'packages/a/package.json': JSON.stringify({ dependencies: { dependency: '1' } }), 'standalone/package.json': JSON.stringify({ dependencies: { dependency: '1' } }) });
    expect((await scanSupplyChain(root)).findings.filter(item => item.kind === 'lockfile-missing').map(item => item.file)).toEqual(['standalone/package.json']);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ workspaces: {} }));
    expect((await scanSupplyChain(root)).findings.filter(item => item.kind === 'lockfile-missing')).toHaveLength(2);
    await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));
    await expect(scanSupplyChain(root)).rejects.toMatchObject({ code: 'security-lockfile-unsupported' });
    await fs.writeFile(path.join(root, 'package.json'), '{');
    await expect(scanSupplyChain(root)).rejects.toMatchObject({ code: 'security-manifest-invalid' });
  });
  it('reports missing package membership when the ancestor manifest disappears between reads', async () => {
    const root = await repo({ 'package.json': JSON.stringify({ workspaces: ['packages/*'] }), 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {} }), 'packages/a/package.json': JSON.stringify({ dependencies: { dependency: '1' } }) });
    const read = fs.readFile.bind(fs);
    let rootReads = 0;
    vi.spyOn(fs, 'readFile').mockImplementation(async (file, ...options: Parameters<typeof fs.readFile> extends [unknown, ...infer R] ? R : never) => {
      if (String(file) === path.join(root, 'package.json') && ++rootReads > 1) throw new Error('ancestor disappeared');
      return read(file, ...options);
    });
    expect((await scanSupplyChain(root)).findings.map(finding => finding.kind)).toContain('lockfile-missing');
  });
  it('handles nested workspace locks and selects a direct component over repeated transitive copies', async () => {
    const root = await repo({
      'empty/package.json': '{}',
      'workspace/package.json': JSON.stringify({ workspaces: ['sub/*'] }),
      'workspace/package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/pkg': { version: '1' }, 'node_modules/repeated/node_modules/pkg': { version: '1' }, 'node_modules/dev': { version: '1', dev: true }, 'node_modules/repeated/node_modules/dev': { version: '1', dev: true }, 'node_modules/': { version: '1' }, 'node_modules/nested/node_modules/': { version: '1' } } }),
      'workspace/sub/a/package.json': JSON.stringify({ dependencies: { pkg: '1' } }),
    });
    const report = await scanSupplyChain(root);
    expect(report.components).toEqual([expect.objectContaining({ name: 'dev', development: true }), expect.objectContaining({ name: 'pkg', direct: true })]);
    expect(report.gaps).toHaveLength(4);
    expect(report.findings).toEqual([]);
  });
});

describe('governance integration with recorded human evidence', () => {
  it('retains and sorts expired attributed exceptions without suppressing future violations', async () => {
    const root = await repo();
    for (const id of ['z', 'a']) await addGovernanceException({ root, now: new Date('2019-01-01T00:00:00.000Z'), exception: { id, policy: 'tester-handoff', owner: 'owner', reason: 'Temporary migration', recordedAt: '2019-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:00:00.000Z' } });
    const report = await evaluateGovernanceAtRoot({ cwd: root, graph: new EvidenceGraphBuilder().build(), now: new Date('2026-01-01T00:00:00.000Z') });
    expect(report.expiredExceptions.map(exception => exception.id)).toEqual(['a', 'z']);
    expect(report.suppressed).toEqual([]);
  });
  it('rejects stale tester handoffs and requires a comparison base for both change policies', async () => {
    const root = await repo({ 'a.ts': 'export const value = 1;', 'docgen.config.json': JSON.stringify({ governance: { policies: { changedFeaturesRequirePlan: true, changesRequireHandoff: true } } }) });
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore', windowsHide: true });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'add', '.'], { cwd: root, stdio: 'ignore', windowsHide: true });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Fixture'], { cwd: root, stdio: 'ignore', windowsHide: true });
    await fs.writeFile(path.join(root, 'a.ts'), 'export const value = 2;');
    const graph = new EvidenceGraphBuilder().build();
    const config = await loadConfig({ root });
    const missing = await evaluateGovernanceAtRoot({ cwd: root, graph });
    expect(missing.violations.map(violation => violation.policy)).toEqual(['changed-feature-plan', 'tester-handoff']);
    const handoff = path.join(root, 'docs/handoffs/tester-handoff.md');
    await fs.mkdir(path.dirname(handoff), { recursive: true });
    for (const content of ['# Stale handoff', '- Base: `HEAD`\n## Changed files (1)\n| modified | `other.ts` | |', '- Base: `other`\n## Changed files (1)\n| modified | `a.ts` | |']) {
      await fs.writeFile(handoff, content);
      const report = await evaluateGovernanceAtRoot({ cwd: root, graph, base: 'HEAD' });
      expect(report.violations).toEqual([expect.objectContaining({ policy: 'tester-handoff', message: expect.stringContaining('does not match') })]);
    }
    expect(config.governance.policies.changesRequireHandoff).toBe(true);
  });
  it('rejects unresolved change and plan links and records broken test citations as gaps', () => {
    const builder = new EvidenceGraphBuilder();
    const human = { origin: 'human' as const, evidence: [], actor: 'owner' };
    const empty = builder.build();
    expect(() => mapPlansIntoGraph(empty, [plan])).toThrow('not registered');
    expect(() => mapChangesIntoGraph(empty, [change])).toThrow('missing feature');
    builder.addNode({ id: 'feature:a', label: 'A', kind: 'feature', provenance: human });
    const graph = builder.build();
    expect(() => mapChangesIntoGraph(graph, [{ ...change, planIds: ['missing'] }])).toThrow('missing plan');
    for (const field of ['surfaceIds', 'requirementIds', 'testFiles'] as const) expect(() => mapChangesIntoGraph(graph, [{ ...change, [field]: ['missing'] }])).toThrow('missing');
    const mapped = mapChangesIntoGraph(graph, [{ ...change, headCommit: 'a'.repeat(40), headDate: date }]);
    expect(mapped.nodes.find(node => node.kind === 'change')?.properties).toMatchObject({ headCommit: 'a'.repeat(40), headDate: date });
    const requirement = { id: 'REQ-a-01', questionId: 'q', title: 'A', statement: 'A', kind: 'requirement' as const, status: 'confirmed' as const, surfaceId: 'a', recordedBy: 'owner', recordedAt: date };
    const gaps = mapRequirementsIntoGraph({ graph, requirements: new Map([['a', { surfaceId: 'a', slug: 'a', requirements: [requirement] }], ['b', { surfaceId: 'b', slug: 'b', requirements: [] }]]), testReferences: [{ id: 'REQ-missing-01', file: 'b.test.ts', line: 1 }, { id: 'REQ-a-01', file: 'a.test.ts', line: 1 }] });
    expect(gaps.gaps.map(gap => gap.kind)).toEqual(expect.arrayContaining(['requirement-surface-missing', 'test-requirement-missing']));
  });
  it('passes attributed critical confirmations and detects dangling test citations', async () => {
    const root = await repo({ 'docgen.config.json': JSON.stringify({ governance: { policies: { criticalFeaturesRequireVerification: true, requirementsRequireTests: true } } }), 'a.test.ts': '// REQ-missing-01\n' });
    const owned = { ...feature, criticality: 'critical' as const, selectors: { files: ['a.ts'], nodes: [ 'api:a' ] } };
    const { sourceFile: _source, ...record } = owned;
    await writeNewFeatureRecord(root, record);
    const builder = new EvidenceGraphBuilder();
    const provenance = { origin: 'extracted' as const, evidence: [{ file: 'a.ts', line: 1 }] };
    builder.addNode({ id: 'surface:api:a', kind: 'surface', label: 'A', provenance, properties: { surfaceId: 'api:a' } });
    builder.addNode({ id: 'file:a.ts', kind: 'file', label: 'a.ts', provenance });
    builder.addNode({ id: 'feature:a', kind: 'feature', label: 'A', provenance: { origin: 'human', evidence: [], actor: 'owner' } });
    builder.addEdge({ id: 'member', kind: 'belongs-to-feature', from: 'file:a.ts', to: 'feature:a', provenance });
    const graph = builder.build();
    const body = featureCardSchema.parse({ summary: { text: 'A', evidence: [{ file: 'a.ts', line: 1 }] }, unknowns: [{ id: 'q', question: 'Confirmed?', why: 'Needs review' }] });
    await saveCards(root, [{ surfaceId: 'api:a', slug: 'a', title: 'A', kind: 'screen', body, producedBy: 'test', inputHash: '', promptVersion: '', answered: [] }]);
    await recordRequirement({ root, surfaceId: 'api:a', slug: 'a', kind: 'requirement', title: 'A', statement: 'A', questionId: 'q', recordedBy: 'owner', recordedAt: date });
    const before = await evaluateGovernanceAtRoot({ cwd: root, graph });
    expect(before.violations.some(item => item.message.includes('unanswered'))).toBe(true);
    await recordAnswer({ root, surfaceId: 'api:a', slug: 'a', answer: { questionId: 'q', question: 'Confirmed?', answer: 'yes', answeredBy: 'owner', answeredAt: date } });
    const after = await evaluateGovernanceAtRoot({ cwd: root, graph, configFile: 'docgen.config.json', now: new Date(date) });
    expect(after.violations.filter(item => item.policy === 'critical-feature-verification')).toEqual([]);
    expect(after.violations.some(item => item.message.includes('unknown requirement'))).toBe(true);
    expect((await loadConfig({ root })).governance.policies.requirementsRequireTests).toBe(true);
  });
  it('rejects pilot traversal and renders reviewed and draft metrics', async () => {
    const root = await repo();
    const logger = createLogger({ level: 'silent' });
    await expect(evaluatePilot({ root, manifestFile: '../outside.json', logger })).rejects.toMatchObject({ code: 'pilot-manifest-outside-root' });
    const quality = { truePositives: 1, falsePositives: 0, falseNegatives: 0, precision: 1, recall: 1 };
    const report = { schemaVersion: 1 as const, repository: 'test', repositoryClass: 'library' as const, reviewStatus: 'approved' as const, reviewedBy: 'owner', reviewedAt: date, observed: { technologies: [], unsupportedTechnologies: ['unsupported'], graphNodes: 0, graphEdges: 0, graphGaps: [] }, quality: { technologies: quality, graphGaps: { ...quality, precision: null, recall: null }, overall: quality } };
    expect(renderPilotReport(report)).toContain('Human-reviewed quality');
    expect(renderPilotReport({ ...report, reviewStatus: 'draft' })).toContain('Draft quality');
    expect(renderPilotReport(report)).toContain('n/a');
  });
});
