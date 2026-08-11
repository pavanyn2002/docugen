import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';
import type { FileFingerprintManifest } from '../src/graph/fingerprints.js';
import {
  acceptScopedGraphPartitions,
  mergeGraphPartitions,
  mergeReusableGraphPartitions,
  partitionEvidenceGraph,
  planGraphPartitionRebuild,
  updateGraphPartitions,
} from '../src/graph/partitions.js';
import {
  parseGraphPartitions,
  readGraphPartitions,
  serialiseGraphPartitions,
  writeGraphPartitions,
} from '../src/graph/partition-store.js';
import { serialiseEvidenceGraph } from '../src/graph/serialize.js';

const provenance = (file: string) => ({
  origin: 'extracted' as const,
  evidence: [{ file, line: 1 }],
  extractionMethods: ['ast' as const],
  certainty: 'high' as const,
});

const profile = {
  engineVersion: 'test',
  includeSymbols: true,
  configSha256: 'a'.repeat(64),
  symbolAdaptersSha256: 'b'.repeat(64),
} as const;

function graph(version: 'before' | 'after', includeDependency = true) {
  const builder = new EvidenceGraphBuilder();
  builder.addNode({ id: 'symbol:a', kind: 'symbol', label: 'caller', provenance: provenance('src/a.ts') });
  builder.addNode({
    id: 'symbol:b',
    kind: 'symbol',
    label: version === 'before' ? 'target' : 'updated target',
    provenance: provenance('src/b.ts'),
  });
  builder.addNode({ id: 'symbol:c', kind: 'symbol', label: 'independent', provenance: provenance('src/c.ts') });
  if (includeDependency) {
    builder.addEdge({
      id: 'edge:call',
      kind: 'calls',
      from: 'symbol:a',
      to: 'symbol:b',
      provenance: provenance('src/a.ts'),
    });
  }
  return builder.build();
}

function fingerprints(bHash: string): FileFingerprintManifest {
  const hash = (character: string) => character.repeat(64);
  return {
    schemaVersion: 1,
    files: [
      { file: 'src/a.ts', bytes: 1, sha256: hash('a') },
      { file: 'src/b.ts', bytes: 1, sha256: hash(bHash) },
      { file: 'src/c.ts', bytes: 1, sha256: hash('c') },
    ],
  };
}

describe('graph partitions', () => {
  it('round-trips a graph exactly through evidence-owned partitions', () => {
    const clean = graph('before');
    const manifest = partitionEvidenceGraph(clean, fingerprints('b'), profile);

    expect(manifest.partitions.map((partition) => partition.key)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
    expect(serialiseEvidenceGraph(mergeGraphPartitions(manifest))).toBe(serialiseEvidenceGraph(clean));
  });

  it('invalidates reverse dependants, reuses independent partitions, and proves equivalence', () => {
    const previous = partitionEvidenceGraph(graph('before'), fingerprints('b'), profile);
    const result = updateGraphPartitions({
      previous,
      cleanGraph: graph('after'),
      fingerprints: fingerprints('d'),
      changes: { added: [], changed: ['src/b.ts'], deleted: [], unchanged: ['src/a.ts', 'src/c.ts'] },
      profile,
    });

    expect(result.mode).toBe('incremental');
    expect(result.candidateEquivalent).toBe(true);
    expect(result.invalidated).toEqual(['$global', 'src/a.ts', 'src/b.ts']);
    expect(result.reused).toEqual(['src/c.ts']);
    expect(serialiseEvidenceGraph(mergeGraphPartitions(result.manifest))).toBe(
      serialiseEvidenceGraph(graph('after')),
    );
  });

  it('plans a scoped rebuild and rejects mutations to reused partitions', () => {
    const previous = partitionEvidenceGraph(graph('before'), fingerprints('b'), profile);
    const changes = {
      added: [],
      changed: ['src/b.ts'],
      deleted: [],
      unchanged: ['src/a.ts', 'src/c.ts'],
    };
    const plan = planGraphPartitionRebuild({ previous, changes, profile });

    expect(plan).toEqual({
      mode: 'incremental',
      invalidated: ['$global', 'src/a.ts', 'src/b.ts'],
      reused: ['src/c.ts'],
    });
    expect(mergeReusableGraphPartitions(previous, plan.invalidated).nodes.map((node) => node.id)).toEqual([
      'symbol:c',
    ]);
    expect(
      acceptScopedGraphPartitions({
        previous,
        graph: graph('after'),
        fingerprints: fingerprints('d'),
        invalidated: plan.invalidated,
        profile,
      })?.mode,
    ).toBe('incremental');

    const mutatedReuse = new EvidenceGraphBuilder();
    mutatedReuse.addNode({
      id: 'symbol:a',
      kind: 'symbol',
      label: 'caller',
      provenance: provenance('src/a.ts'),
    });
    mutatedReuse.addNode({
      id: 'symbol:b',
      kind: 'symbol',
      label: 'updated target',
      provenance: provenance('src/b.ts'),
    });
    mutatedReuse.addNode({
      id: 'symbol:c',
      kind: 'symbol',
      label: 'changed independent',
      provenance: provenance('src/c.ts'),
    });
    expect(
      acceptScopedGraphPartitions({
        previous,
        graph: mutatedReuse.build(),
        fingerprints: fingerprints('d'),
        invalidated: plan.invalidated,
        profile,
      }),
    ).toBeUndefined();
  });

  it('falls back to the clean partition set when invalidation input misses a semantic change', () => {
    const result = updateGraphPartitions({
      previous: partitionEvidenceGraph(graph('before'), fingerprints('b'), profile),
      cleanGraph: graph('after', false),
      fingerprints: fingerprints('b'),
      changes: { added: [], changed: [], deleted: [], unchanged: ['src/a.ts', 'src/b.ts', 'src/c.ts'] },
      profile,
    });

    expect(result.mode).toBe('fallback');
    expect(result.candidateEquivalent).toBe(false);
    expect(result.reused).toEqual([]);
    expect(serialiseEvidenceGraph(mergeGraphPartitions(result.manifest))).toBe(
      serialiseEvidenceGraph(graph('after', false)),
    );
  });

  it('does not reuse partitions produced by a different extraction profile', () => {
    const result = updateGraphPartitions({
      previous: partitionEvidenceGraph(graph('before'), fingerprints('b'), profile),
      cleanGraph: graph('before'),
      fingerprints: fingerprints('b'),
      changes: { added: [], changed: [], deleted: [], unchanged: ['src/a.ts', 'src/b.ts', 'src/c.ts'] },
      profile: { ...profile, includeSymbols: false },
    });

    expect(result.mode).toBe('full');
    expect(result.reused).toEqual([]);
    expect(result.manifest.includeSymbols).toBe(false);
  });

  it('atomically stores schema-validated partition manifests', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-partitions-'));
    const file = path.join(root, 'cache', 'partitions.json');
    try {
      const manifest = partitionEvidenceGraph(graph('before'), fingerprints('b'), profile);
      const first = await writeGraphPartitions(file, manifest);
      const second = await writeGraphPartitions(file, manifest);
      expect(first.sha256).toBe(second.sha256);
      expect(serialiseGraphPartitions(await readGraphPartitions(file) as typeof manifest)).toBe(
        serialiseGraphPartitions(manifest),
      );
      expect(() => parseGraphPartitions('{broken')).toThrow(/not valid JSON/);
      expect(() => parseGraphPartitions('{"schemaVersion":99}')).toThrow(/schema v1/);
      expect((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
