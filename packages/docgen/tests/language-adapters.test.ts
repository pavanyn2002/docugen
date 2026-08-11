import { describe, expect, it } from 'vitest';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';
import {
  applySymbolLanguageAdapters,
  getSymbolLanguageAdapterReports,
} from '../src/graph/language-adapters.js';
import type { SymbolLanguageAdapter } from '../src/graph/language-adapters.js';

function adapter(
  id: string,
  backend: SymbolLanguageAdapter['backend'],
  calls: string[],
): SymbolLanguageAdapter {
  return {
    id,
    version: '1',
    backend,
    languages: [id],
    fileExtensions: [`.${id}`],
    enrich: async ({ graph }) => {
      calls.push(id);
      return graph;
    },
  };
}

describe('symbol language adapters', () => {
  it('publishes the built-in Python, TypeScript, and JavaScript capabilities', () => {
    expect(getSymbolLanguageAdapterReports()).toEqual([
      {
        id: 'python',
        version: '2',
        backend: 'tree-sitter',
        languages: ['Python'],
        fileExtensions: ['.py'],
      },
      {
        id: 'typescript-javascript',
        version: '4',
        backend: 'typescript-compiler-api',
        languages: ['JavaScript', 'TypeScript'],
        fileExtensions: ['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'],
      },
    ]);
  });

  it('runs compiler and Tree-sitter adapters in stable id order', async () => {
    const calls: string[] = [];
    const result = await applySymbolLanguageAdapters({
      graph: new EvidenceGraphBuilder().build(),
      root: '.',
      exclude: [],
      adapters: [
        adapter('python', 'tree-sitter', calls),
        adapter('javascript', 'typescript-compiler-api', calls),
      ],
    });

    expect(calls).toEqual(['javascript', 'python']);
    expect(result.adapters.map((item) => `${item.id}:${item.backend}`)).toEqual([
      'javascript:typescript-compiler-api',
      'python:tree-sitter',
    ]);
  });

  it('rejects duplicate adapter identities before executing them', async () => {
    const calls: string[] = [];
    await expect(
      applySymbolLanguageAdapters({
        graph: new EvidenceGraphBuilder().build(),
        root: '.',
        exclude: [],
        adapters: [adapter('python', 'tree-sitter', calls), adapter('python', 'tree-sitter', calls)],
      }),
    ).rejects.toThrow(/registered more than once/);
    expect(calls).toEqual([]);
  });

  it('rejects invalid evidence returned by an adapter', async () => {
    const invalid: SymbolLanguageAdapter = {
      ...adapter('python', 'tree-sitter', []),
      enrich: async () => ({
        schemaVersion: 1,
        nodes: [],
        edges: [
          {
            id: 'edge:dangling',
            kind: 'calls',
            from: 'symbol:missing-a',
            to: 'symbol:missing-b',
            provenance: { origin: 'extracted', evidence: [{ file: 'app.py', line: 1 }] },
          },
        ],
        gaps: [],
      }),
    };

    await expect(
      applySymbolLanguageAdapters({
        graph: new EvidenceGraphBuilder().build(),
        root: '.',
        exclude: [],
        adapters: [invalid],
      }),
    ).rejects.toThrow(/returned an invalid evidence graph/);
  });
});
