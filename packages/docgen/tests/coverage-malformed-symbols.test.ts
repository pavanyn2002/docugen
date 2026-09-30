import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';
import { enrichGraphWithTypeScriptSymbols } from '../src/graph/symbols.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('TypeScript parser recovery', () => {
  it('does not publish empty identities for incomplete declarations', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-incomplete-symbol-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'main.ts'), 'function () { unknown(); }\nclass { method() {} }\n');
    const graph = await enrichGraphWithTypeScriptSymbols({ root, exclude: [], graph: new EvidenceGraphBuilder().build() });
    expect(graph.nodes.filter((node) => node.kind === 'symbol' && node.label === '')).toEqual([]);
    expect(graph.edges.filter((edge) => edge.kind === 'calls')).toEqual([]);
  });
});
