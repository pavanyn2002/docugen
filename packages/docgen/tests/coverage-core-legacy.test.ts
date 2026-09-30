import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inventoryLegacyDocuments } from '../src/legacy/inventory.js';
import { mapLegacyInventoryToGraph } from '../src/legacy/mapping.js';
import { buildLegacyOperationPlans, writeLegacyOperationPlans } from '../src/legacy/plans.js';
import { legacyMigrationManifestSchema } from '../src/legacy/schema.js';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';

const roots: string[] = [];
async function repo(files: Record<string, string> = {}) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-core-legacy-')); roots.push(root); for (const [file, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); } return root; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('legacy prose inventory and grounded mapping', () => {
  it('classifies every prose format and ownership while filtering unsupported links', async () => {
    const root = await repo({ 'a.mdx': '[local](target.txt)\n[fragment](#heading) [remote](https://host/x) [mail](mailto:a) [bad](foo\\bar) [space]( ) [outside](../outside) [parent](..) [root](/absolute) [query](?query) [data](data:text) [protocol](//host) [tel](tel:1)\n', 'b.rst': 'Restructured', 'c.adoc': 'Asciidoc', 'd.txt': 'Text', 'target.txt': 'Target', 'docs/.answers/human.md': 'record', 'docs/legacy-archive/old.md': 'archived', 'docs/generated/page.md': 'generated', 'docs/handoffs/qa.md': 'handoff' });
    const inventory = await inventoryLegacyDocuments({ root, outDir: 'docs/generated' });
    expect(inventory.documents.find(document => document.path === 'a.mdx')?.references).toEqual([{ target: 'absolute', exists: false, graphNodeIds: [] }, { target: 'target.txt', exists: true, graphNodeIds: [] }]);
    expect(inventory.documents.map(document => document.format)).toEqual(expect.arrayContaining(['mdx', 'restructured-text', 'asciidoc', 'text', 'markdown']));
    expect(inventory.counts).toMatchObject({ docgenRecords: 1, archivedHuman: 1, docgenGenerated: 2 });
    const read = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation(async (file, ...options: Parameters<typeof fs.readFile> extends [unknown, ...infer R] ? R : never) => { if (String(file).endsWith('d.txt')) throw new Error('file disappeared'); return read(file, ...options); });
    expect((await inventoryLegacyDocuments({ root, outDir: 'docs/generated' })).documents.some(document => document.path === 'd.txt')).toBe(false);
  });
  it('maps unique anchors, distinguishes ambiguous names and ignores code fences', async () => {
    const root = await repo({ 'mapped.md': '[source](a.ts "title")\n[external](https://example.test) [mail](mailto:owner) [bad](a\\b) [fragment](#part) [empty]( ) [parent](..) [query](?query)\n', 'fully-mapped.md': '`unique`', 'partial.md': '`unique`\nUnknown behavior\n', 'ambiguous.md': '`shared`\n', 'empty.md': '---\n    code example\n```\n`unique`\n```\n', 'missing.md': '[missing](missing.ts)\n', 'a.ts': 'code', 'unreadable.md': 'Temporary', 'docs/generated/owned.md': '<!-- docgen:generated -->\n# Owned' });
    const inventory = await inventoryLegacyDocuments({ root, outDir: 'docs/generated' });
    const builder = new EvidenceGraphBuilder();
    const provenance = { origin: 'extracted' as const, evidence: [] };
    builder.addNode({ id: 'file:a.ts', kind: 'file', label: 'a.ts', provenance });
    builder.addNode({ id: 'unique', kind: 'symbol', label: 'unique', provenance, properties: { name: 'unique' } });
    builder.addNode({ id: 'shared1', kind: 'symbol', label: 'shared', provenance });
    builder.addNode({ id: 'shared2', kind: 'symbol', label: 'shared', provenance });
    builder.addNode({ id: 'empty', kind: 'symbol', label: '', provenance });
    await fs.rm(path.join(root, 'unreadable.md'));
    const mapped = await mapLegacyInventoryToGraph({ root, inventory, graph: builder.build() });
    expect(mapped.documents.find(document => document.path === 'mapped.md')?.claims[0]).toMatchObject({ mapping: 'mapped', matchedBy: ['local-reference'] });
    expect(mapped.documents.find(document => document.path === 'fully-mapped.md')?.evidenceStatus).toBe('mapped');
    expect(mapped.documents.find(document => document.path === 'partial.md')?.evidenceStatus).toBe('partial');
    expect(mapped.documents.find(document => document.path === 'ambiguous.md')?.claims[0]?.mapping).toBe('ambiguous');
    expect(mapped.documents.find(document => document.path === 'empty.md')?.claims).toEqual([]);
    expect(mapped.documents.find(document => document.path === 'missing.md')?.evidenceStatus).toBe('orphaned-references');
    expect(mapped.documents.find(document => document.path === 'unreadable.md')?.claims).toEqual([]);
    expect(mapped.documents.find(document => document.path === 'docs/generated/owned.md')?.ownership).toBe('docgen-generated');
  });
  it('derives archived execution timestamps and leaves plans unchanged on publication failure', async () => {
    const root = await repo({ 'source.md': 'Source', 'replacement.md': 'Replacement' });
    const inventory = await inventoryLegacyDocuments({ root, outDir: 'docs/generated' });
    const source = inventory.documents.find(document => document.path === 'source.md')!;
    const { format: _format, ownership: _ownership, bytes: _bytes, references: _references, ...document } = source;
    const manifest = legacyMigrationManifestSchema.parse({ schemaVersion: 1, createdBy: 'owner', createdAt: '2026-01-01T00:00:00.000Z', evidenceGraphSha256: 'a'.repeat(64), policy: 'no-human-document-moves-without-approval', documents: [{ ...document, proposedAction: 'replace', replacementPaths: ['replacement.md'], approval: { required: true, status: 'approved' }, classificationHistory: [{ from: 'unreviewed', to: 'current', decidedBy: 'owner', decidedAt: '2026-01-02T00:00:00.000Z', reason: 'reviewed', evidenceGraphSha256: 'a'.repeat(64) }], approvalHistory: [{ from: 'pending', to: 'approved', decidedBy: 'owner', decidedAt: '2026-01-03T00:00:00.000Z', reason: 'reviewed', evidenceGraphSha256: 'a'.repeat(64) }], execution: { status: 'archived', source: 'source.md', target: 'docs/legacy-archive/source.md', sourceSha256: source.sha256, executedBy: 'owner', executedAt: '2026-01-04T00:00:00.000Z' } }] });
    const plans = await buildLegacyOperationPlans({ root, manifest: { ...manifest, documents: [manifest.documents[0]!, { ...manifest.documents[0]!, path: 'second.md', replacementPaths: ['missing.md'] }, { ...manifest.documents[0]!, path: 'current.md', proposedAction: 'retain' }] } });
    expect(plans.archive.plannedAt).toBe('2026-01-04T00:00:00.000Z');
    expect(plans.archive.documents.find(document => document.path === 'source.md')).toMatchObject({ readyForExecution: false, executionStatus: 'archived' });
    expect(plans.replacement.documents[0]?.readyForApproval).toBe(false);
    const error = new Error('publication denied');
    vi.spyOn(fs, 'rename').mockRejectedValue(error);
    vi.spyOn(fs, 'rm').mockRejectedValue(new Error('cleanup denied'));
    await expect(writeLegacyOperationPlans(root, plans)).rejects.toBe(error);
  });
});
