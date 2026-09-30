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

  it('keeps TypeScript parameter initializers outside the function body scope', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-default-scope-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'main.ts'), 'function inner() { return 1; }\nexport function outer(value = inner()) {\n  function inner() { return 2; }\n  inner();\n  return value;\n}\n');
    const graph = await enrichGraphWithTypeScriptSymbols({ root, exclude: [], graph: new EvidenceGraphBuilder().build() });
    expect(graph.edges.filter((edge) => edge.kind === 'calls').map((edge) => ({ to: edge.to, evidence: edge.provenance.evidence })))
      .toEqual([
        { to: 'symbol:main.ts#function:inner', evidence: [expect.objectContaining({ line: 2 })] },
        { to: 'symbol:main.ts#function:outer.inner', evidence: [expect.objectContaining({ line: 4 })] },
      ]);
  });

  it('resolves this dispatch to the class method even when a nested function has the same name', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-method-scope-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'main.ts'), 'export class Service { execute() {} run() { function execute() {} execute(); this.execute(); } }\n');
    const graph = await enrichGraphWithTypeScriptSymbols({ root, exclude: [], graph: new EvidenceGraphBuilder().build() });
    expect(graph.edges.filter((edge) => edge.kind === 'calls').map((edge) => edge.to)).toEqual([
      'symbol:main.ts#function:Service.run.execute', 'symbol:main.ts#method:Service.execute',
    ]);
  });

  it('does not attribute Python signature evaluation to a function body', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-python-signature-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'main.py'), 'def helper():\n    return int\n\ndef outer() -> helper():\n    def helper():\n        pass\n    return 1\n');
    const graph = await enrichGraphWithPythonSymbols({ root, exclude: [], graph: new EvidenceGraphBuilder().build() });
    expect(graph.edges.filter((edge) => edge.kind === 'calls')).toEqual([]);
  });
});
