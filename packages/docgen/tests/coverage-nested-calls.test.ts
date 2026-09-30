import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';
import { enrichGraphWithPythonSymbols } from '../src/graph/python-symbols.js';
import { enrichGraphWithTypeScriptSymbols } from '../src/graph/symbols.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('nested lexical call visibility', () => {
  it.each([
    { file: 'main.py', source: 'def outer():\n    def inner():\n        pass\n    inner()\n\ndef unrelated():\n    inner()\n', enrich: enrichGraphWithPythonSymbols },
    { file: 'main.ts', source: 'export function outer() { function inner() {} inner(); }\nexport function unrelated() { inner(); }\n', enrich: enrichGraphWithTypeScriptSymbols },
  ])('resolves the enclosing function call in $file without leaking its definition to unrelated callers', async ({ file, source, enrich }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-nested-calls-'));
    roots.push(root);
    await fs.writeFile(path.join(root, file), source);
    const graph = await enrich({ root, exclude: [], graph: new EvidenceGraphBuilder().build() });
    expect(graph.edges.filter((edge) => edge.kind === 'calls')).toEqual([
      expect.objectContaining({ from: `symbol:${file}#function:outer`, to: `symbol:${file}#function:outer.inner` }),
    ]);
  });
});
