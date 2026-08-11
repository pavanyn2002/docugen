import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';
import { EvidenceGraphIndex } from '../src/graph/query.js';
import { serialiseEvidenceGraph } from '../src/graph/serialize.js';
import {
  parseEvidenceGraph,
  readEvidenceGraph,
  writeEvidenceGraph,
} from '../src/graph/store.js';
import type { EvidenceGraph, GraphEdgeKind, GraphNodeKind } from '../src/graph/types.js';

const evidence = { origin: 'extracted' as const, evidence: [{ file: 'src/graph.ts', line: 1 }] };

function fixtureGraph(): EvidenceGraph {
  const builder = new EvidenceGraphBuilder();
  const nodes: readonly { id: string; kind: GraphNodeKind; label: string }[] = [
    { id: 'route:/checkout', kind: 'route', label: '/checkout' },
    { id: 'endpoint:POST:/payments', kind: 'endpoint', label: 'POST /payments' },
    { id: 'symbol:createPayment', kind: 'symbol', label: 'createPayment' },
    { id: 'schema:payments', kind: 'schema', label: 'payments' },
    { id: 'job:payment-retry', kind: 'job', label: 'payment-retry' },
  ];
  for (const node of nodes) builder.addNode({ ...node, provenance: evidence });

  const edges: readonly [GraphEdgeKind, string, string][] = [
    ['implemented-by', 'route:/checkout', 'endpoint:POST:/payments'],
    ['handled-by', 'endpoint:POST:/payments', 'symbol:createPayment'],
    ['references', 'symbol:createPayment', 'schema:payments'],
    ['handled-by', 'endpoint:POST:/payments', 'job:payment-retry'],
    ['references', 'job:payment-retry', 'schema:payments'],
  ];
  for (const [kind, from, to] of edges) {
    builder.addEdge({ id: `edge:${kind}:${from}->${to}`, kind, from, to, provenance: evidence });
  }
  return builder.build();
}

describe('evidence graph queries', () => {
  it('searches by label and kind with stable ordering', () => {
    const index = new EvidenceGraphIndex(fixtureGraph());

    expect(index.search({ text: 'payment', kinds: ['endpoint', 'job'] }).map((node) => node.id)).toEqual([
      'endpoint:POST:/payments',
      'job:payment-retry',
    ]);
    expect(index.search({ limit: 1 })).toHaveLength(1);
    expect(() => index.search({ limit: -1 })).toThrow(/non-negative integer/);
  });

  it('returns filtered incoming and outgoing relationships', () => {
    const index = new EvidenceGraphIndex(fixtureGraph());

    expect(
      index
        .neighbors('endpoint:POST:/payments', { direction: 'outgoing', edgeKinds: ['handled-by'] })
        .map((item) => item.node.id),
    ).toEqual(['job:payment-retry', 'symbol:createPayment']);

    const explanation = index.explain('schema:payments');
    expect(explanation.outgoing).toEqual([]);
    expect(explanation.incoming.map((item) => item.node.id)).toEqual([
      'job:payment-retry',
      'symbol:createPayment',
    ]);
  });

  it('finds a deterministic shortest path', () => {
    const index = new EvidenceGraphIndex(fixtureGraph());
    const path = index.findPath('route:/checkout', 'schema:payments', { direction: 'outgoing' });

    expect(path?.nodes.map((node) => node.id)).toEqual([
      'route:/checkout',
      'endpoint:POST:/payments',
      'job:payment-retry',
      'schema:payments',
    ]);
    expect(path?.edges).toHaveLength(3);
    expect(index.findPath('schema:payments', 'route:/checkout', { direction: 'outgoing' })).toBeUndefined();
    expect(index.findPath('schema:payments', 'schema:payments')?.edges).toEqual([]);
  });
});

describe('evidence graph store', () => {
  it('atomically writes and reads canonical, schema-validated JSON', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-graph-store-'));
    const file = path.join(tmp, 'cache', 'evidence-graph.json');
    const graph = fixtureGraph();

    try {
      const first = await writeEvidenceGraph(file, graph);
      const second = await writeEvidenceGraph(file, graph);
      const loaded = await readEvidenceGraph(file);

      expect(first.sha256).toBe(second.sha256);
      expect(first.bytes).toBe(Buffer.byteLength(serialiseEvidenceGraph(graph)));
      expect(serialiseEvidenceGraph(loaded)).toBe(serialiseEvidenceGraph(graph));
      expect((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects malformed, incompatible, and dangling indexes', () => {
    expect(() => parseEvidenceGraph('{broken', 'broken.json')).toThrow(/not valid JSON/);
    expect(() => parseEvidenceGraph('{"schemaVersion":99}', 'future.json')).toThrow(/schema v1/);

    const dangling = JSON.stringify({
      schemaVersion: 1,
      nodes: [
        {
          id: 'file:src/a.ts',
          kind: 'file',
          label: 'src/a.ts',
          provenance: evidence,
        },
      ],
      edges: [
        {
          id: 'edge:imports:file:src/a.ts->file:missing.ts',
          kind: 'imports',
          from: 'file:src/a.ts',
          to: 'file:missing.ts',
          provenance: evidence,
        },
      ],
      gaps: [],
    });
    expect(() => parseEvidenceGraph(dangling, 'dangling.json')).toThrow(/invalid relationship/);
  });
});
