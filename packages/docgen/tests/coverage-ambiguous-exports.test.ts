import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';
import { enrichGraphWithTypeScriptSymbols } from '../src/graph/symbols.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('ambiguous TypeScript exported call targets', () => {
  it('does not choose one implementation when two local definitions export the same name', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-export-ambiguity-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'library.ts'), 'export function shared() {}\nfunction other() {}\nexport { other as shared };\n');
    await fs.writeFile(path.join(root, 'caller.ts'), "import { shared } from './library';\nexport function caller() { shared(); }\n");
    const graph = await enrichGraphWithTypeScriptSymbols({ root, exclude: [], graph: new EvidenceGraphBuilder().build() });
    expect(graph.nodes.filter((node) => node.kind === 'symbol')).toHaveLength(3);
    expect(graph.edges.filter((edge) => edge.kind === 'calls')).toEqual([]);
  });
});
