import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderFacts } from '../src/infer/facts.js';
import { buildSurfaceContext } from '../src/infer/context.js';
import { inferCards, validateCardEvidence, parseCardBody } from '../src/infer/cards.js';
import { loadCards, saveCards } from '../src/infer/store.js';
import { featureCardSchema } from '../src/infer/types.js';
import type { FeatureCard } from '../src/infer/types.js';
import { isAttributedAnswer } from '../src/infer/verification.js';
import { selectGraphNeighborhood, renderGraphNeighborhood } from '../src/infer/graph-context.js';
import { renderBehaviourIndex, renderBehaviourPage } from '../src/infer/behaviour.js';
import { writeBehaviourPages } from '../src/infer/write-behaviour.js';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';
import type { Surface } from '../src/surface/types.js';
import type { EntryBase, ExtractResult } from '../src/types/core.js';
import { createLogger } from '../src/util/logger.js';
import { CARDS_DIR } from '../src/config/paths.js';
import { section } from '../src/render/markdown.js';
import { projectRenderResults } from '../src/render/projection.js';
import { validateMermaid, safeNodeId } from '../src/render/mermaid-validate.js';

const roots: string[] = [];
const source = { file: 'a.ts' };
const surface: Surface = { id: 'api:a', slug: 'a', title: 'A', kind: 'screen', origin: 'derived', sourceFiles: ['a.ts'], routes: ['r1', 'r2'], supportingRoutes: [], endpoints: ['e1', 'e2'], jobs: ['j1', 'j2', 'j3'] };
const entry = { source, extractionMethod: 'ast' as const, certainty: 'high' as const };
const result = <T extends EntryBase>(entries: readonly T[]): ExtractResult<T> => ({ extractor: 'routes', entries, gaps: [], skips: [], detected: [], applicable: true, durationMs: 0 });
const body = featureCardSchema.parse({ summary: { text: 'A', evidence: [{ file: 'a.ts', line: 1 }] } });
const card: FeatureCard = { surfaceId: surface.id, slug: 'a', title: 'A', kind: 'api', body, producedBy: 'test', inputHash: '', promptVersion: '', answered: [] };
const context = { engineVersion: 'test', generatedAt: '2026-01-01', root: '.' };
async function repo(files: Record<string, string> = {}) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-core-infer-')); roots.push(root); for (const [file, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); } return root; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('inference context and trusted evidence', () => {
  it('renders all extracted fact types and distinguishes missing authentication evidence', () => {
    const text = renderFacts(surface, {
      routes: result([ { ...entry, id: 'r1', path: '/one', kind: 'page', params: [], isCatchAll: false, layoutChain: [], guards: [] }, { ...entry, id: 'r2', path: '/two', kind: 'page', params: [], isCatchAll: false, layoutChain: [], guards: [{ name: 'auth', source }] } ]),
      endpoints: result([ { ...entry, id: 'e1', method: 'GET', path: '/one', params: [], middleware: [] }, { ...entry, id: 'e2', method: 'POST', path: '/two', params: [], middleware: ['auth'], requestShape: { name: 'Input', kind: 'zod' } } ]),
      jobs: result([ { ...entry, id: 'j1', name: 'daily', kind: 'cron', schedule: 'daily' }, { ...entry, id: 'j2', name: 'consumer', kind: 'queue-consumer', channel: 'queue' }, { ...entry, id: 'j3', name: 'worker', kind: 'worker' } ]),
      schema: result([ { ...entry, id: 's1', name: 'table', kind: 'table', fields: Array.from({ length: 26 }, (_, i) => ({ name: `f${i}`, type: 'string' })), indexes: [], relations: [] } ]),
      config: result([ { ...entry, id: 'c1', name: 'ENV', kind: 'env', reads: [source], declarations: [], isSecretLike: false }, { ...entry, id: 'c2', name: 'OTHER', kind: 'env', reads: [{ file: 'other.ts' }], declarations: [], isSecretLike: false } ]),
    });
    for (const expected of ['does NOT mean it is public', 'guards: auth', 'validates against Input', 'schedule daily', 'on message to queue', 'trigger not determined', 'Reads environment variables: ENV', 'f24, …']) expect(text).toContain(expected);
    expect(text).not.toContain('OTHER');
    expect(renderFacts(surface, { schema: result([{ ...entry, id: 'short', name: 'short', kind: 'table', fields: [{ name: 'id', type: 'string' }], indexes: [], relations: [] }]) })).toContain('with fields: id');
  });
  it('omits paths outside the repository and reports long omission lists', async () => {
    const root = await repo({ 'a.ts': 'password="secret123"' });
    const options = { root, surface: { ...surface, sourceFiles: ['..', '../outside', 'D:/outside', 'missing1', 'missing2', 'missing3'] }, bundle: {}, limits: { maxFiles: 5, maxBytesPerFile: 100, maxTotalBytes: 100 } };
    const bounded = await buildSurfaceContext(options);
    expect(bounded.omittedFiles).toHaveLength(6);
    expect(bounded.code).toContain('…');
    const disclosed = await buildSurfaceContext({ ...options, surface, redact: false });
    expect(disclosed.code).toContain('secret123');
    expect(disclosed.redactions).toBe(0);
  });
  it('uses graph evidence windows, handles evidence beyond EOF, and applies exact byte limits', async () => {
    const root = await repo({ 'a.ts': Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') });
    const builder = new EvidenceGraphBuilder();
    builder.addNode({ id: 'surface:api:a', label: 'A', kind: 'surface', provenance: { origin: 'extracted', evidence: [{ file: 'a.ts', line: 50 }, { file: 'a.ts', line: 55 }, { file: 'a.ts', line: 55, column: 1 }, { file: 'a.ts', line: 55, column: 2 }, { file: 'a.ts', line: 95 }, { file: 'a.ts', column: 2 }] } });
    const graph = builder.build();
    const options = { root, surface, bundle: {}, graph, limits: { maxFiles: 1, maxBytesPerFile: 10000, maxTotalBytes: 10000 } };
    const selected = await buildSurfaceContext(options);
    expect(selected.includedEvidence).toEqual([{ file: 'a.ts', startLine: 30, endLine: 100 }]);
    const tiny = await buildSurfaceContext({ ...options, limits: { maxFiles: 1, maxBytesPerFile: 1, maxTotalBytes: 100 } });
    expect(tiny.includedEvidence).toEqual([]);
    const { graph: _graph, ...withoutGraph } = options;
    const exact = await buildSurfaceContext({ ...withoutGraph, limits: { maxFiles: 1, maxBytesPerFile: 15, maxTotalBytes: 100 } });
    expect(exact.includedEvidence).toEqual([{ file: 'a.ts', startLine: 1, endLine: 1 }]);
    const beyond = new EvidenceGraphBuilder();
    beyond.addNode({ id: 'surface:api:a', label: 'A', kind: 'surface', provenance: { origin: 'extracted', evidence: [{ file: 'a.ts', line: 1000 }] } });
    const fallback = await buildSurfaceContext({ ...options, graph: beyond.build() });
    expect(fallback.includedEvidence).toEqual([{ file: 'a.ts', startLine: 1, endLine: 1 }]);
  });
  it('excludes human edges and marks graph caps without transmitting dangling edges', () => {
    const builder = new EvidenceGraphBuilder();
    const extracted = { origin: 'extracted' as const, evidence: [{ file: 'a.ts' }] };
    builder.addNode({ id: 'surface:api:a', label: 'A', kind: 'surface', provenance: extracted });
    for (const id of ['b', 'c']) builder.addNode({ id, label: id, kind: 'file', provenance: extracted });
    builder.addEdge({ id: 'ab', from: 'surface:api:a', to: 'b', kind: 'contains', provenance: { origin: 'human', evidence: [], actor: 'owner' } });
    builder.addEdge({ id: 'ac', from: 'surface:api:a', to: 'c', kind: 'contains', provenance: extracted });
    const graph = builder.build();
    const capped = selectGraphNeighborhood({ graph, surfaceId: surface.id, maxEdges: 0 });
    expect(capped?.edges).toEqual([]);
    expect(renderGraphNeighborhood(capped)).toContain('safety cap');
    expect(selectGraphNeighborhood({ graph, surfaceId: surface.id, maxDepth: 0 })?.nodes).toHaveLength(1);
    const nodes = selectGraphNeighborhood({ graph, surfaceId: surface.id, maxNodes: 1 });
    expect(nodes?.truncated).toBe(true);
    expect(nodes?.edges).toEqual([]);
    const human = new EvidenceGraphBuilder();
    human.addNode({ id: 'surface:api:a', label: 'A', kind: 'surface', provenance: { origin: 'human', evidence: [], actor: 'owner' } });
    expect(selectGraphNeighborhood({ graph: human.build(), surfaceId: surface.id })).toBeUndefined();
    expect(renderGraphNeighborhood({ seedId: 'a', nodes: [{ id: 'a', label: 'A', kind: 'surface', provenance: { origin: 'extracted', evidence: [] } }], edges: [], evidence: [], truncated: false })).toContain('[surface] A');
  });
  it('orders evidence with absent source columns across distinct graph entities', () => {
    const builder = new EvidenceGraphBuilder();
    builder.addNode({ id: 'surface:api:a', kind: 'surface', label: 'A', provenance: { origin: 'extracted', evidence: [{ file: 'a.ts', line: 1, column: 2 }] } });
    builder.addNode({ id: 'symbol:a.ts#x', kind: 'symbol', label: 'x', provenance: { origin: 'extracted', evidence: [{ file: 'a.ts', line: 1 }] } });
    builder.addEdge({ id: 'contains:x', kind: 'contains', from: 'surface:api:a', to: 'symbol:a.ts#x', provenance: { origin: 'extracted', evidence: [] } });
    expect(selectGraphNeighborhood({ graph: builder.build(), surfaceId: surface.id })?.evidence).toEqual([{ file: 'a.ts', line: 1 }, { file: 'a.ts', line: 1, column: 2 }]);
  });
  it('rejects inferred citations and reports missing prompt files without using backend', async () => {
    const root = await repo({ 'a.ts': 'hello' });
    const backend = { id: 'test', name: 'Test', setupHint: '', isAvailable: async () => true, run: vi.fn(async () => ({ ok: true as const, text: JSON.stringify({ summary: { text: 'unseen', evidence: [{ file: 'outside.ts', line: 1 }] } }) })) };
    const options = { root, surfaces: [surface], bundle: {}, answers: new Map(), backend, limits: { maxFiles: 1, maxBytesPerFile: 100, maxTotalBytes: 100 }, timeoutMs: 1000, logger: createLogger({ level: 'silent' }), redactSecrets: false, model: 'test-model' };
    expect((await inferCards(options)).failures[0]?.reason).toContain('not included');
    backend.run.mockClear();
    vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('prompt missing'));
    await expect(inferCards(options)).rejects.toThrow('Could not locate prompt pack');
    expect(backend.run).not.toHaveBeenCalled();
  });
  it('rejects non-relative citations, absent line numbers and root-level schema failures', () => {
    expect(parseCardBody('{bad}')).toMatchObject({ ok: false, reason: expect.stringContaining('malformed JSON') });
    expect(parseCardBody('{"unterminated": true')).toMatchObject({ ok: false, reason: expect.stringContaining('no JSON object') });
    for (const file of ['../outside.ts', '/outside.ts']) expect(validateCardEvidence({ ...body, summary: { text: 'A', evidence: [{ file, line: 1 }] } }, [])).toContain('invalid or non-relative');
    expect(validateCardEvidence({ ...body, summary: { text: 'A', evidence: [{ file: 'a.ts' }] } }, [{ file: 'a.ts', startLine: 1, endLine: 2 }])).toContain('without a line number');
    expect(parseCardBody('{"summary":{"text":"A","evidence":[{"file":"a.ts"}]},"unexpected":true}')).toMatchObject({ ok: false, reason: expect.stringContaining('(root)') });
  });
  it('includes omission disclosure and canonical ordering when inferring multiple surfaces', async () => {
    const root = await repo({ 'a.ts': 'hello', 'b.ts': 'hello' });
    const backend = { id: 'test', name: 'Test', setupHint: '', isAvailable: async () => true, run: vi.fn(async () => ({ ok: true as const, text: JSON.stringify(body) })) };
    const options = { root, surfaces: [{ ...surface, slug: 'z', sourceFiles: ['a.ts', 'b.ts'] }, { ...surface, id: 'api:second', slug: 'a', sourceFiles: ['a.ts'] }], bundle: {}, answers: new Map(), backend, limits: { maxFiles: 1, maxBytesPerFile: 100, maxTotalBytes: 100 }, timeoutMs: 1000, logger: createLogger({ level: 'silent' }) };
    expect((await inferCards(options)).cards.map(card => card.slug)).toEqual(['a', 'z']);
    const bounded = await buildSurfaceContext({ root, surface, bundle: {}, limits: { maxFiles: 1, maxBytesPerFile: 100, maxTotalBytes: 0 } });
    expect(bounded.omittedFiles).toEqual(['a.ts']);
    backend.run.mockResolvedValue({ ok: true, text: '{}' });
    expect((await inferCards(options)).failures.map(failure => failure.slug)).toEqual(['a', 'z']);
  });
  it('reuses a reviewed cached card and records answer ids without another provider call', async () => {
    const root = await repo({ 'a.ts': 'hello' });
    const answers = new Map([[surface.id, { surfaceId: surface.id, slug: surface.slug, answers: [{ questionId: 'q', question: '', answer: 'Reviewed', answeredBy: 'owner', answeredAt: '', note: 'Review note' }] }]]);
    const backend = { id: 'test', name: 'Test', setupHint: '', isAvailable: async () => true, run: vi.fn(async () => ({ ok: true as const, text: JSON.stringify({ summary: { text: 'A', evidence: [{ file: 'a.ts' }] } }) })) };
    const options = { root, surfaces: [surface], bundle: {}, answers, backend, limits: { maxFiles: 1, maxBytesPerFile: 100, maxTotalBytes: 100 }, timeoutMs: 1000, logger: createLogger({ level: 'silent' }) };
    // Stored cards from older versions may omit evidence lines; the renderer must still display them.
    expect(renderBehaviourPage({ card: { ...card, body: featureCardSchema.parse({ summary: { text: 'A', evidence: [{ file: 'a.ts' }] } }) }, answers: answers.get(surface.id), context, outDir: 'docs/generated' })).toContain('Review note');
    backend.run.mockResolvedValue({ ok: true, text: JSON.stringify(body) });
    const first = await inferCards(options);
    const cached = await inferCards({ ...options, previous: new Map(first.cards.map(card => [card.surfaceId, card])) });
    expect(cached.cards[0]?.answered).toEqual(['q']);
    expect(backend.run).toHaveBeenCalledTimes(1);
    await inferCards({ ...options, surfaces: [{ ...surface, sourceFiles: ['missing'] }] });
  });
  it('loads partial card metadata and never deletes human cache files', async () => {
    const values = [null, 'text', {}, { body }, { surfaceId: surface.id, slug: 'a', body }, { surfaceId: 'second', slug: 'b', body, answered: ['q', 1] }];
    const root = await repo(Object.fromEntries(values.map((value, i) => [`${CARDS_DIR}/${i}.yaml`, YAML.stringify(value)])));
    expect((await loadCards(root)).get(surface.id)).toMatchObject({ title: 'a', kind: 'screen', producedBy: 'unknown', inputHash: '', promptVersion: '', answered: [] });
    expect((await loadCards(root)).get('second')?.answered).toEqual(['q']);
    await saveCards(root, [card], { replace: true });
    await expect(fs.stat(path.join(root, `${CARDS_DIR}/0.yaml`))).resolves.toBeDefined();
  });
  it('requires complete, attributed confirmations and renders empty behavior indexes', async () => {
    const answer = { questionId: 'q', question: 'Question', answer: 'Yes', answeredBy: 'owner', answeredAt: '2026-01-01' };
    expect(isAttributedAnswer(answer)).toBe(true);
    for (const partial of [{ ...answer, question: '' }, { ...answer, answer: '' }, { ...answer, answeredBy: '' }, { ...answer, answeredBy: 'unknown' }, { ...answer, answeredAt: 'invalid' }]) expect(isAttributedAnswer(partial)).toBe(false);
    expect(renderBehaviourIndex({ cards: [], answers: new Map(), context, outDir: 'docs/generated' })).toContain('No surfaces');
    const root = await repo();
    vi.spyOn(fs, 'readdir').mockRejectedValueOnce(new Error('directory disappeared'));
    expect(await writeBehaviourPages({ root, cards: [], answers: new Map(), context, outDir: 'docs/generated' })).toEqual(['docs/generated/behaviour.md']);
  });
  it('preserves old human behavior pages and ignores directories while deleting obsolete generated pages', async () => {
    const root = await repo({ 'docs/generated/behaviour/human.md': '# Human', 'docs/generated/behaviour/obsolete.md': '<!-- docgen:generated -->\n# Old', 'docs/generated/behaviour/notes.txt': 'Notes' });
    await fs.mkdir(path.join(root, 'docs/generated/behaviour/directory.md'));
    await writeBehaviourPages({ root, cards: [card], answers: new Map(), context, outDir: 'docs/generated' });
    await expect(fs.readFile(path.join(root, 'docs/generated/behaviour/human.md'), 'utf8')).resolves.toBe('# Human');
    await expect(fs.stat(path.join(root, 'docs/generated/behaviour/obsolete.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(path.join(root, 'docs/generated/behaviour/directory.md'))).isDirectory()).toBe(true);
  });
});

describe('render error diagnostics', () => {
  it('distinguishes unknown diagram types and empty sources', () => {
    expect(validateMermaid('')).toEqual([expect.objectContaining({ kind: 'empty-diagram' })]);
    expect(validateMermaid('unsupportedDiagram')).toEqual([expect.objectContaining({ kind: 'unknown-diagram-type' })]);
  });
  it('rejects missing or malformed graph render projections', () => {
    const envelope = result([{ ...entry, id: 'a' }]);
    const graph = (properties?: { renderEntryV1: string }) => ({ schemaVersion: 1 as const, nodes: [{ id: 'route:a', kind: 'route' as const, label: 'A', provenance: { origin: 'extracted' as const, extractors: ['routes' as const], evidence: [] }, ...(properties === undefined ? {} : { properties }) }], edges: [], gaps: [] });
    expect(() => projectRenderResults(graph(), new Map([['routes', envelope]]))).toThrow('no renderEntryV1');
    expect(() => projectRenderResults(graph({ renderEntryV1: '{' }), new Map([['routes', envelope]]))).toThrow('invalid renderEntryV1');
    expect(section('Empty', '  ')).toBe('## Empty\n\n');
    expect(() => projectRenderResults({ ...graph({ renderEntryV1: JSON.stringify({ ...entry, id: 'wrong' }) }) }, new Map([['routes', envelope]]))).toThrow('does not match');
    const nodes = ['c', 'a', 'b'].map(id => ({ id: `route:${id}`, kind: 'route' as const, label: id, provenance: { origin: 'extracted' as const, extractors: ['routes' as const], evidence: [] }, properties: { renderEntryV1: JSON.stringify({ ...entry, id }) } }));
    expect(projectRenderResults({ schemaVersion: 1, nodes, edges: [], gaps: [] }, new Map([['routes', result(['c', 'a', 'b'].map(id => ({ ...entry, id })))]] )).get('routes')?.entries.map(entry => entry.id)).toEqual(['a', 'b', 'c']);
  });
  it('reports unsafe Mermaid node ids, raw escaped quotes and unmatched closing blocks', () => {
    const problems = validateMermaid('graph TD\nend[bare]\nend --> x\nnode["escaped \\"quote\\""]\n}\n');
    expect(problems.map(problem => problem.kind)).toEqual(expect.arrayContaining(['reserved-node-id', 'unquoted-label', 'unbalanced-block', 'unescaped-quote-in-label']));
    expect(safeNodeId('', 'end')).toBe('_end_node');
    expect(safeNodeId('', '---')).toBe('_root');
  });
});
