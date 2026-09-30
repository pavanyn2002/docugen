import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceGraphBuilder, validateEvidenceGraph } from '../src/graph/builder.js';
import { EvidenceGraphIndex } from '../src/graph/query.js';
import { ensureDefaultGraphCacheIgnored, readEvidenceGraphIfExists, writeEvidenceGraph } from '../src/graph/store.js';
import { readGraphPartitions, writeGraphPartitions, parseGraphPartitions } from '../src/graph/partition-store.js';
import { partitionEvidenceGraph } from '../src/graph/partitions.js';
import { mergeGraphPartitions, planGraphPartitionRebuild, updateGraphPartitions } from '../src/graph/partitions.js';
import { buildEvidenceGraph } from '../src/graph/from-extraction.js';
import { readFileFingerprints, writeFileFingerprints, diffFileFingerprints, parseFileFingerprints } from '../src/graph/fingerprints.js';
import { applySymbolLanguageAdapters, type SymbolLanguageAdapter } from '../src/graph/language-adapters.js';
import { preserveSessionBaseline, readImpactBaseline, SESSION_BASELINE_FILE } from '../src/graph/session-baseline.js';
import { mapSurfacesIntoGraph } from '../src/graph/surfaces.js';
import { summarizeChangeSurfaces } from '../src/graph/impact-summary.js';
import { analyzeChangeImpact } from '../src/graph/impact.js';
import { chunkSurfaces } from '../src/surface/chunk.js';
import { residualSegments } from '../src/surface/group.js';
import { owningWorkspace } from '../src/detect/ownership.js';
import { scopeExtractResult } from '../src/extract/types.js';
import { computeFindings } from '../src/analysis/findings.js';
import { loadConfig } from '../src/config/load.js';
import { runExtraction } from '../src/pipeline.js';
import { createLogger } from '../src/util/logger.js';
import { route, endpoint, job } from './helpers/entries.js';
import type { EvidenceGraph, GraphNode } from '../src/graph/types.js';
import type { RoutesResult, SchemaResult, ConfigResult, DepsResult, EndpointsResult, JobsResult } from '../src/types/entries.js';
import type { ExtractorId, ExtractResult } from '../src/types/core.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-graph-boundaries-'));
  roots.push(root);
  for (const [file, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), contents);
  }
  return root;
}
const provenance = { origin: 'extracted' as const, evidence: [{ file: 'a.ts', line: 1 }] };
function graph(nodes: GraphNode[] = []): EvidenceGraph {
  const builder = new EvidenceGraphBuilder();
  nodes.forEach(node => builder.addNode(node));
  return builder.build();
}

describe('graph persistence failures retain actionable error codes', () => {
  it('reports atomic writes blocked by a file in the parent path', async () => {
    const root = await repository({ blocker: 'ordinary file' });
    const target = path.join(root, 'blocker', 'index.json');
    const empty = graph();
    const manifest = partitionEvidenceGraph(empty, undefined, { engineVersion: '1', includeSymbols: false, configSha256: 'a'.repeat(64), symbolAdaptersSha256: 'b'.repeat(64) });
    await expect(writeEvidenceGraph(target, empty)).rejects.toMatchObject({ code: 'graph-index-write-failed', file: target });
    await expect(writeGraphPartitions(target, manifest)).rejects.toMatchObject({ code: 'graph-partitions-write-failed', file: target });
    await expect(writeFileFingerprints(target, { schemaVersion: 1, files: [] })).rejects.toMatchObject({ code: 'fingerprint-index-write-failed', file: target });
    await expect(ensureDefaultGraphCacheIgnored(path.join(root, 'blocker'))).rejects.toMatchObject({ code: expect.stringMatching(/ENOTDIR|EEXIST/) });
  });

  it('distinguishes absent and malformed persisted indexes', async () => {
    const root = await repository({ 'graph.json': '{', 'partitions.json': '{', 'fingerprints.json': '{' });
    expect(await readEvidenceGraphIfExists(path.join(root, 'absent'))).toBeUndefined();
    expect(await readGraphPartitions(path.join(root, 'absent'))).toBeUndefined();
    expect(await readFileFingerprints(path.join(root, 'absent'))).toBeUndefined();
    await expect(readEvidenceGraphIfExists(path.join(root, 'graph.json'))).rejects.toMatchObject({ code: 'graph-index-unparseable' });
    await expect(readGraphPartitions(path.join(root, 'partitions.json'))).rejects.toMatchObject({ code: 'graph-partitions-unparseable' });
    await expect(readFileFingerprints(path.join(root, 'fingerprints.json'))).rejects.toMatchObject({ code: 'fingerprint-index-unparseable' });
  });

  it('rejects well-shaped partitions with dangling relationships', () => {
    const manifest = partitionEvidenceGraph(graph(), undefined, { engineVersion: '1', includeSymbols: false, configSha256: 'a'.repeat(64), symbolAdaptersSha256: 'b'.repeat(64) });
    expect(() => parseGraphPartitions(JSON.stringify({ ...manifest, partitions: [{ key: 'a.ts', nodes: [], edges: [{ id: 'dangling', kind: 'calls', from: 'missing', to: 'missing2', provenance }], gaps: [] }] }))).toThrow(expect.objectContaining({ code: 'graph-partitions-invalid' }));
    expect(() => parseGraphPartitions(JSON.stringify({ ...manifest, partitions: [{ key: 'same', nodes: [], edges: [], gaps: [] }, { key: 'same', nodes: [], edges: [], gaps: [] }] }))).toThrow(expect.objectContaining({ code: 'graph-partitions-duplicate-key' }));
  });

  it('recognizes content-identical byte size changes independently of hashes', () => {
    const before = { schemaVersion: 1 as const, files: [{ file: 'a.ts', bytes: 1, sha256: 'a'.repeat(64) }] };
    expect(diffFileFingerprints(before, { ...before, files: [{ ...before.files[0]!, bytes: 2 }] }).changed).toEqual(['a.ts']);
    expect(() => parseFileFingerprints(JSON.stringify({ ...before, files: [before.files[0], before.files[0]] }))).toThrow(expect.objectContaining({ code: 'fingerprint-index-duplicate-file' }));
  });

  it('handles invalid baseline records and refuses unsafe revision arguments', async () => {
    const root = await repository({ [SESSION_BASELINE_FILE]: '{' });
    await expect(readImpactBaseline(root)).rejects.toMatchObject({ code: 'graph-session-baseline-invalid' });
    for (const base of ['--help', 'HEAD\n', 'HEAD\0']) await expect(preserveSessionBaseline(root, base)).resolves.toBeUndefined();
    await expect(preserveSessionBaseline(root, 'HEAD')).resolves.toBeUndefined();
  });
});

describe('graph adapter and traversal edge cases', () => {
  it('uses the closer baseline evidence when a surviving node moves away from the changed file', () => {
    const create = (baseline: boolean) => {
      const builder = new EvidenceGraphBuilder();
      for (const id of ['a', 'b', 'c']) builder.addNode({ id, kind: 'symbol', label: baseline && id === 'c' ? 'previous-c' : id, provenance: { ...provenance, evidence: [{ file: id === 'c' && baseline ? 'a.ts' : `${id}.ts` }] } });
      builder.addEdge({ id: 'b-a', kind: 'calls', from: 'b', to: 'a', provenance: { ...provenance, evidence: [{ file: 'b.ts' }] } });
      if (!baseline) builder.addEdge({ id: 'c-b', kind: 'calls', from: 'c', to: 'b', provenance: { ...provenance, evidence: [{ file: 'c.ts' }] } });
      return builder.build();
    };
    const report = analyzeChangeImpact({ current: create(false), baseline: create(true), changes: { base: 'HEAD', changes: [{ status: 'modified', file: 'a.ts' }] } });
    expect(report.files[0]?.impacted.find(item => item.node.id === 'c')).toMatchObject({ node: { label: 'previous-c' }, distance: 0, basis: ['baseline', 'current'] });
  });

  it.each([
    ['graph-provenance-conflict', { origin: 'human' as const }],
    ['graph-actor-conflict', { actor: 'different' }],
    ['graph-recorded-at-conflict', { recordedAt: 'different' }],
  ])('rejects conflicting attribution with %s', (code, override) => {
    const builder = new EvidenceGraphBuilder();
    const node: GraphNode = { id: 'node', kind: 'symbol', label: 'node', provenance: { ...provenance, actor: 'original', recordedAt: 'original' } };
    builder.addNode(node);
    expect(() => builder.addNode({ ...node, provenance: { ...node.provenance, ...override } })).toThrow(expect.objectContaining({ code }));
  });

  it('merges optional attribution and rejects conflicting node and edge content', () => {
    const builder = new EvidenceGraphBuilder();
    const node: GraphNode = { id: 'node', kind: 'symbol', label: 'node', provenance };
    builder.addNode(node);
    builder.addNode({ ...node, provenance: { ...provenance, actor: 'recorder', recordedAt: 'now' } });
    expect(builder.build().nodes[0]?.provenance).toMatchObject({ actor: 'recorder', recordedAt: 'now' });
    expect(() => builder.addNode({ ...node, label: 'changed' })).toThrow(expect.objectContaining({ code: 'graph-node-conflict' }));
    builder.addEdge({ id: 'edge', kind: 'calls', from: 'node', to: 'node', provenance });
    expect(() => builder.addEdge({ id: 'edge', kind: 'contains', from: 'node', to: 'node', provenance })).toThrow(expect.objectContaining({ code: 'graph-edge-conflict' }));
  });

  it('returns sorted validation issues for duplicate ids and invalid evidence paths', () => {
    const node: GraphNode = { id: 'bad\nnode', kind: 'symbol', label: 'node', provenance: { ...provenance, evidence: [{ file: 'C:/outside.ts' }, { file: '/absolute.ts' }, { file: 'windows\\file.ts' }] } };
    const edge = { id: '', kind: 'calls' as const, from: node.id, to: node.id, provenance: node.provenance };
    const issues = validateEvidenceGraph({ schemaVersion: 1, nodes: [node, node], edges: [edge, edge], gaps: [] });
    expect(issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['invalid-id', 'duplicate-node', 'duplicate-edge', 'invalid-evidence-path']));
    expect(issues.every(issue => issue.subjectId === node.id || issue.subjectId === '')).toBe(true);
    expect(() => new EvidenceGraphIndex({ schemaVersion: 1, nodes: [node, node], edges: [edge, edge], gaps: [] })).toThrow(expect.objectContaining({ code: 'graph-query-invalid' }));
  });

  it.each([
    { version: '' }, { languages: [] }, { fileExtensions: [] }, { fileExtensions: ['ts'] },
  ])('rejects incomplete adapter metadata %j', async override => {
    const adapter: SymbolLanguageAdapter = { id: 'test', version: '1', backend: 'tree-sitter', languages: ['Python'], fileExtensions: ['.py'], enrich: async context => context.graph, ...override };
    await expect(applySymbolLanguageAdapters({ root: '.', exclude: [], graph: graph(), adapters: [adapter] })).rejects.toMatchObject({ code: 'symbol-adapter-metadata-invalid' });
  });

  it('rejects adapter identifiers that cannot form stable portable cache keys', async () => {
    const adapter: SymbolLanguageAdapter = { id: 'Invalid ID', version: '1', backend: 'tree-sitter', languages: ['Python'], fileExtensions: ['.py'], enrich: async context => context.graph };
    await expect(applySymbolLanguageAdapters({ root: '.', exclude: [], graph: graph(), adapters: [adapter] })).rejects.toMatchObject({ code: 'symbol-adapter-id-invalid' });
  });

  it('orders neighbors with parallel relationships and handles directed dead ends', () => {
    const builder = new EvidenceGraphBuilder();
    for (const id of ['a', 'b', 'c', 'isolated']) builder.addNode({ id, kind: 'symbol', label: id === 'c' ? 'Target label' : id, provenance });
    for (const [id, from, to, kind] of [['z', 'a', 'b', 'calls'], ['a', 'a', 'b', 'calls'], ['b', 'a', 'b', 'contains'], ['cycle', 'b', 'a', 'calls'], ['last', 'b', 'c', 'calls']] as const) builder.addEdge({ id, from, to, kind, provenance });
    const index = new EvidenceGraphIndex(builder.build());
    expect(index.neighbors('a', { direction: 'outgoing' }).map(item => item.edge.id)).toEqual(['a', 'z', 'b']);
    expect(index.neighbors('c', { direction: 'outgoing' })).toEqual([]);
    expect(index.neighbors('isolated', { direction: 'incoming' })).toEqual([]);
    expect(index.neighbors('a', { direction: 'incoming', edgeKinds: ['contains'] })).toEqual([]);
    expect(index.search({ text: 'Target label' }).map(node => node.id)).toEqual(['c']);
    expect(index.search({ text: 'absent', kinds: ['file'] })).toEqual([]);
    expect(index.findPath('a', 'c', { direction: 'outgoing', maxDepth: 1 })).toBeUndefined();
    expect(index.findPath('a', 'isolated', { direction: 'outgoing' })).toBeUndefined();
    expect(index.findPath('c', 'a', { direction: 'incoming' })?.nodes.map(node => node.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('surface evidence and grouping edge cases', () => {
  it('projects route guards, response shapes, seeded schemas and unresolved dependency targets', () => {
    const seeded = graph([
      { id: 'schema:seed', kind: 'schema', label: 'users', properties: { modelName: 'User', workspace: 'app' }, provenance },
      { id: 'schema:second', kind: 'schema', label: 'users', properties: { modelName: 'User', workspace: 'app' }, provenance },
      { id: 'schema:unique', kind: 'schema', label: 'unique', provenance },
      { id: 'module:seed', kind: 'module', label: 'old.ts', provenance },
    ]);
    const base = { applicable: true, detected: [], gaps: [], skips: [], durationMs: 0 };
    const routes: RoutesResult = { ...base, extractor: 'routes', entries: [{ ...route('/bare'), guards: [{ name: 'Auth', source: { file: 'guard.ts' } }] }] };
    const endpoints: EndpointsResult = { ...base, extractor: 'endpoints', entries: [{ ...endpoint('GET', '/bare'), responseShape: { name: 'Response', kind: 'typescript', source: { file: 'response.ts' } } }] };
    const schema: SchemaResult = { ...base, extractor: 'schema', entries: [
      { id: 'schema:child', source: { file: 'child.ts' }, extractionMethod: 'schema', certainty: 'high', workspace: 'app', name: 'child', kind: 'table', fields: [], indexes: [], relations: [{ field: 'owner', targetModel: 'User' }] },
      { id: 'schema:local', source: { file: 'local.ts' }, extractionMethod: 'schema', certainty: 'high', name: 'local', kind: 'table', fields: [{ name: 'bare', type: 'text' }], indexes: [], relations: [{ field: 'target', targetModel: 'unique' }, { field: 'missing', targetModel: 'Missing' }] },
    ] };
    const deps: DepsResult = { ...base, extractor: 'deps', cycles: [], entries: [{ id: 'module:new', source: { file: 'new.ts' }, extractionMethod: 'ast', certainty: 'high', module: 'new.ts', imports: ['old.ts', 'missing.ts'], externals: [] }] };
    const projected = buildEvidenceGraph(new Map<ExtractorId, ExtractResult>([['routes', routes], ['endpoints', endpoints], ['schema', schema], ['deps', deps]]), seeded);
    expect(projected.edges.filter(edge => edge.kind === 'returns')).toHaveLength(1);
    expect(projected.edges.find(edge => edge.kind === 'references' && edge.to === 'schema:unique')?.properties).toEqual({ field: 'target' });
    expect(projected.edges.find(edge => edge.kind === 'imports' && edge.to === 'module:seed')).toBeDefined();
    expect(projected.gaps.map(gap => gap.kind)).toEqual(expect.arrayContaining(['graph-relation-target-ambiguous', 'graph-relation-target-unresolved', 'graph-import-target-unresolved']));
  });

  it('rebuilds global partitions and closes cyclic file dependencies deterministically', () => {
    const builder = new EvidenceGraphBuilder();
    builder.addNode({ id: 'a', kind: 'symbol', label: 'a', provenance });
    builder.addNode({ id: 'b', kind: 'symbol', label: 'b', provenance: { ...provenance, evidence: [{ file: 'b.ts' }] } });
    builder.addNode({ id: 'global', kind: 'feature', label: 'global', provenance: { origin: 'extracted', evidence: [] } });
    builder.addEdge({ id: 'ab', kind: 'calls', from: 'a', to: 'b', provenance });
    builder.addEdge({ id: 'ba', kind: 'calls', from: 'b', to: 'a', provenance: { ...provenance, evidence: [{ file: 'b.ts' }] } });
    builder.addGap({ extractor: 'schema', kind: 'z', message: 'z' });
    builder.addGap({ extractor: 'schema', kind: 'a', message: 'a' });
    builder.addGap({ extractor: 'jobs', kind: 'a', message: 'a' });
    const clean = builder.build();
    const profile = { engineVersion: '1', includeSymbols: false, configSha256: 'a'.repeat(64), symbolAdaptersSha256: 'b'.repeat(64) };
    const previous = partitionEvidenceGraph(clean, undefined, profile);
    expect(previous.partitions.find(partition => partition.key === '$global')?.gaps.map(gap => `${gap.extractor}:${gap.kind}`)).toEqual(['jobs:a', 'schema:a', 'schema:z']);
    expect(mergeGraphPartitions(previous)).toEqual(clean);
    const changes = { added: [], changed: ['a.ts'], deleted: [], unchanged: ['b.ts'] };
    expect(planGraphPartitionRebuild({ previous, changes, profile }).invalidated).toEqual(['$global', 'a.ts', 'b.ts']);
    expect(planGraphPartitionRebuild({ changes, profile }).mode).toBe('full');
    const noNodes = graph();
    expect(updateGraphPartitions({ previous, cleanGraph: noNodes, fingerprints: { schemaVersion: 1, files: [] }, changes: { added: [], changed: [], deleted: ['a.ts', 'b.ts'], unchanged: [] }, profile }).manifest.partitions).toEqual([]);
    expect(updateGraphPartitions({ previous: partitionEvidenceGraph(noNodes, undefined, profile), cleanGraph: graph([{ id: 'new', kind: 'symbol', label: 'new', provenance: { ...provenance, evidence: [{ file: 'new.ts' }] } }]), fingerprints: { schemaVersion: 1, files: [] }, changes: { added: [], changed: [], deleted: [], unchanged: [] }, profile }).mode).toBe('incremental');
  });

  it('shares overrides among screens, support entries, endpoints and jobs', () => {
    const result = chunkSurfaces({
      routes: [route('/page', { file: 'shared/page.tsx' }), route('/', { kind: 'layout', file: 'shared/layout.tsx' }), route('/outside', { layoutChain: ['shared/custom.tsx'] }), route('/unrelated', { kind: 'layout', file: 'shared/custom.tsx' })],
      endpoints: [endpoint('POST', '/save', { file: 'shared/routes.ts' })],
      jobs: [job('save', { file: 'shared/job.ts' })],
      overrides: [{ id: 'shared', kind: 'screen', include: ['shared/page.tsx', 'shared/layout.tsx', 'shared/routes.ts', 'shared/job.ts'] }, { id: 'missing-z', kind: 'job', include: ['none/z'] }, { id: 'missing-a', kind: 'job', include: ['none/a'] }],
    });
    expect(result.surfaces.find(surface => surface.id === 'shared')).toMatchObject({ title: 'shared', origin: 'override', routes: ['route:page:/page'], supportingRoutes: ['route:layout:/'], endpoints: ['endpoint:POST:/save'], jobs: ['job:save'] });
    expect(result.surfaces.find(surface => surface.id === 'screen:/outside')?.supportingRoutes).toEqual(['route:layout:/unrelated']);
    expect(result.gaps.map(gap => gap.message)).toEqual([expect.stringContaining('missing-a'), expect.stringContaining('missing-z')]);
    expect(residualSegments('/api', ['/'])).toEqual([]);
    expect(residualSegments('/api', ['/api'])).toEqual([]);
    expect(owningWorkspace('unknown.ts', [{ dir: 'app', manifests: [] }])).toBe('');
    expect(owningWorkspace('app/one.ts', [{ dir: 'app', manifests: [] }, { dir: 'app', manifests: [] }])).toBe('app');
  });

  it('rejects ambiguous graph surface overrides and rebuilds old surface evidence', async () => {
    const root = await repository();
    const config = await loadConfig({ root });
    const routeNode: GraphNode = { id: 'route:page', kind: 'route', label: '/page', properties: { routeKind: 'page' }, provenance };
    expect(() => mapSurfacesIntoGraph(graph([routeNode]), { ...config, surfaces: { ...config.surfaces, overrides: [{ id: 'a', kind: 'screen', include: ['a.ts'] }, { id: 'b', kind: 'screen', include: ['a.ts'] }] } })).toThrow(expect.objectContaining({ code: 'surface-override-ambiguous' }));
    const builder = new EvidenceGraphBuilder();
    builder.addNode(routeNode);
    builder.addNode({ id: 'route:layout', kind: 'route', label: '/', properties: { routeKind: 'layout' }, provenance });
    builder.addNode({ id: 'route:orphan', kind: 'route', label: '/orphan', properties: { routeKind: 'error' }, provenance });
    builder.addNode({ id: 'job:no-evidence', kind: 'job', label: 'background', provenance: { origin: 'extracted', evidence: [] } });
    builder.addNode({ id: 'endpoint:no-properties', kind: 'endpoint', label: '/external', provenance });
    builder.addNode({ id: 'surface:old', kind: 'surface', label: 'old', provenance });
    builder.addEdge({ id: 'old-member', kind: 'contains', from: 'surface:old', to: routeNode.id, provenance });
    builder.addGap({ extractor: 'surface', kind: 'retained', message: 'retained' });
    const mapped = mapSurfacesIntoGraph(builder.build(), { ...config, surfaces: { ...config.surfaces, overrides: [{ id: 'layout', kind: 'screen', title: 'Layout', include: ['a.ts'] }] } });
    expect(mapped.nodes.some(node => node.id === 'surface:old')).toBe(false);
    expect(mapped.edges.some(edge => edge.id === 'old-member')).toBe(false);
    expect(mapped.nodes.find(node => node.id === 'surface:layout')?.label).toBe('Layout');
    expect(mapped.nodes.find(node => node.id === 'surface:job:background')?.provenance.evidence).toEqual([]);
    expect(mapped.gaps).toEqual([expect.objectContaining({ kind: 'retained' })]);
    const unnamed = mapSurfacesIntoGraph(builder.build(), { ...config, surfaces: { ...config.surfaces, overrides: [{ id: 'fallback-title', kind: 'screen', include: ['a.ts'] }] } });
    expect(unnamed.nodes.find(node => node.id === 'surface:fallback-title')?.label).toBe('fallback-title');
  });

  it('projects impacted shapes and packages into their generated documentation pages', () => {
    const nodes: GraphNode[] = [
      { id: 'shape:a', kind: 'shape', label: 'Body', provenance },
      { id: 'package:a', kind: 'package', label: 'library', provenance },
      { id: 'surface:job', kind: 'surface', label: 'job', properties: { surfaceKind: 'job', surfaceId: 'job:a' }, provenance },
      { id: 'plan:a', kind: 'plan', label: 'plan', properties: { planId: 'a' }, provenance },
      { id: 'plan:b', kind: 'plan', label: 'plan', provenance },
      { id: 'schema:a', kind: 'schema', label: 'table', provenance },
      { id: 'config:a', kind: 'config', label: 'CONFIG', provenance },
    ];
    const summary = summarizeChangeSurfaces({ report: { base: 'HEAD', maxDepth: 1, files: [{ change: { status: 'modified', file: 'a.ts' }, impacted: nodes.map(node => ({ node, distance: 0, basis: ['current'] })) }] }, outDir: 'docs/' });
    expect(summary.generatedPages).toEqual(['docs/README.md', 'docs/api.md', 'docs/config.md', 'docs/diagrams/erd.mmd', 'docs/diagrams/integrations.mmd', 'docs/diagrams/modules.mmd', 'docs/jobs.md', 'docs/plans/a.md', 'docs/schema.md']);
    expect(summary.planIds).toEqual(['a']);
  });
});

describe('scoped extraction and cross-extractor findings', () => {
  it('handles nested cyclic entry payloads without recursing forever', () => {
    const nested: { file: number; children: unknown[] } = { file: 7, children: [] };
    nested.children.push(nested, { file: 'owned\\handler.ts' });
    const owned = { ...route('/'), metadata: nested };
    const result: RoutesResult = { extractor: 'routes', applicable: true, detected: [], entries: [owned, route('/unowned')], gaps: [{ extractor: 'routes', kind: 'global', message: 'global' }, { extractor: 'routes', kind: 'owned', message: 'owned', source: { file: 'owned/handler.ts' } }, { extractor: 'routes', kind: 'unowned', message: 'unowned', source: { file: 'other.ts' } }], skips: [], durationMs: 0 };
    const scoped = scopeExtractResult(result, new Set(['owned/handler.ts']));
    expect(scoped.entries).toEqual([owned]);
    expect(scoped.gaps.map(gap => gap.kind)).toEqual(['global', 'owned']);
  });

  it('distinguishes missing routes, workspace tables and framework-loaded handlers', async () => {
    const root = await repository({ 'referenced.ts': 'KnownTable', 'again.ts': 'KnownTable' });
    const config = await loadConfig({ root });
    const run = await runExtraction({ config, logger: createLogger({ level: 'silent' }) });
    const base = { applicable: true, detected: [], gaps: [], skips: [], durationMs: 0 };
    const routes: RoutesResult = { ...base, extractor: 'routes', entries: [route('/missing', { file: 'missing-route.ts' })] };
    const schema: SchemaResult = { ...base, extractor: 'schema', entries: [
      { id: 'schema:known', source: { file: 'definition.ts' }, extractionMethod: 'schema', certainty: 'high', name: 'KnownTable', kind: 'table', fields: [], indexes: [], relations: [] },
      { id: 'schema:unknown', source: { file: 'definition.ts' }, extractionMethod: 'schema', certainty: 'high', name: 'UnknownTable', workspace: 'app', kind: 'table', fields: [], indexes: [], relations: [] },
      { id: 'schema:empty', source: { file: 'definition.ts' }, extractionMethod: 'schema', certainty: 'high', name: '', kind: 'table', fields: [], indexes: [], relations: [] },
    ] };
    const environment: ConfigResult = { ...base, extractor: 'config', entries: [
      { id: 'config:DECLARED', source: { file: '.env' }, extractionMethod: 'config', certainty: 'high', kind: 'env', name: 'DECLARED', workspace: 'app', declarations: [{ file: '.env' }], reads: [], isSecretLike: false },
      { id: 'config:READ', source: { file: 'handler.ts' }, extractionMethod: 'ast', certainty: 'high', kind: 'env', name: 'READ', workspace: 'app', declarations: [], reads: [{ file: 'handler.ts' }], isSecretLike: false },
    ] };
    const endpoints: EndpointsResult = { ...base, extractor: 'endpoints', entries: [endpoint('GET', '/endpoint', { file: 'endpoint.ts', handler: 'handler.ts' }), endpoint('GET', '/bare', { file: 'bare-endpoint.ts' })] };
    const jobs: JobsResult = { ...base, extractor: 'jobs', entries: [{ ...job('work', { file: 'job.ts' }), handler: { file: 'worker-handler.ts' } }, job('bare', { file: 'bare-job.ts' })] };
    const deps: DepsResult = { ...base, extractor: 'deps', cycles: [], entries: ['endpoint.ts', 'handler.ts', 'bare-endpoint.ts', 'job.ts', 'bare-job.ts', 'worker-handler.ts', 'missing-route.ts', 'orphan.ts'].map(module => ({ id: `module:${module}`, source: { file: module }, extractionMethod: 'ast', certainty: 'high', module, imports: [], externals: [] })) };
    const report = await computeFindings({ ...run, results: new Map<ExtractorId, ExtractResult>([['routes', routes], ['schema', schema], ['config', environment], ['endpoints', endpoints], ['jobs', jobs], ['deps', deps]]) });
    expect(report.findings.find(finding => finding.id === 'dead-routes')?.items).toEqual([expect.objectContaining({ label: '/missing' })]);
    expect(report.findings.find(finding => finding.id === 'unreachable-modules')?.items.map(item => item.label)).toEqual(['orphan.ts']);
    expect(report.findings.find(finding => finding.id === 'unreferenced-tables')?.items.map(item => item.label)).toEqual(['app:UnknownTable', '']);
    expect(report.findings.find(finding => finding.id === 'env-declared-never-read')?.items[0]?.label).toBe('app:DECLARED');
    expect(report.findings.find(finding => finding.id === 'env-read-never-declared')?.items[0]?.label).toBe('app:READ');
  });
});
