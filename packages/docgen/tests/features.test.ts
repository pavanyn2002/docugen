import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runFeatureAddCommand } from '../src/commands/feature.js';
import { deriveFeatureCommitHistory } from '../src/features/history.js';
import { findFeatureRecord, mapFeaturesIntoGraph } from '../src/features/graph.js';
import type { FeatureRecord, StoredFeatureRecord } from '../src/features/schema.js';
import { loadFeatureRecords, serialiseFeatureRecord, writeNewFeatureRecord } from '../src/features/store.js';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';
import { loadConfig } from '../src/config/load.js';
import { runExtraction } from '../src/pipeline.js';
import type { Logger } from '../src/util/logger.js';

const created: string[] = [];

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-features-'));
  created.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function record(overrides: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    schemaVersion: 1,
    id: 'checkout',
    title: 'Checkout',
    aliases: ['payments-checkout'],
    status: 'active',
    owners: ['payments@example.com'],
    criticality: 'high',
    selectors: { files: ['src/checkout/**'], nodes: ['endpoint:create-order'] },
    recordedBy: 'dev@example.com',
    recordedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function logger(stdout: string[]): Logger {
  return {
    level: 'silent',
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    heading: () => undefined,
    output: (message) => stdout.push(message),
  };
}

describe('feature records', () => {
  it('writes canonical human-owned records and resolves stable aliases', async () => {
    const root = await makeRepo();
    const file = await writeNewFeatureRecord(root, record());
    const loaded = await loadFeatureRecords(root);

    expect(file).toBe('docs/.features/checkout.json');
    expect(loaded).toHaveLength(1);
    expect(findFeatureRecord(loaded, 'payments-checkout')?.id).toBe('checkout');
    expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(serialiseFeatureRecord(record()));
    expect(
      (await fs.readdir(path.join(root, 'docs/.features'))).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
    await expect(writeNewFeatureRecord(root, record())).rejects.toThrow(/conflicts with existing feature/);
  });

  it('rejects alias collisions and malformed human records loudly', async () => {
    const root = await makeRepo();
    await writeNewFeatureRecord(root, record());
    await expect(
      writeNewFeatureRecord(
        root,
        record({ id: 'orders', title: 'Orders', aliases: ['checkout'] }),
      ),
    ).rejects.toThrow(/conflicts/);
    await fs.writeFile(path.join(root, 'docs/.features/broken.json'), '{broken');
    await expect(loadFeatureRecords(root)).rejects.toThrow(/not valid JSON/);
  });

  it('creates feature nodes and membership edges from file and node selectors', () => {
    const builder = new EvidenceGraphBuilder();
    const provenance = { origin: 'extracted' as const, evidence: [{ file: 'src/checkout/service.ts', line: 1 }] };
    builder.addNode({ id: 'symbol:charge', kind: 'symbol', label: 'charge', provenance });
    builder.addNode({
      id: 'endpoint:create-order',
      kind: 'endpoint',
      label: 'POST /orders',
      provenance: { origin: 'extracted', evidence: [{ file: 'src/routes.ts', line: 1 }] },
    });
    const stored: StoredFeatureRecord = { ...record(), sourceFile: 'docs/.features/checkout.json' };

    const mapped = mapFeaturesIntoGraph(builder.build(), [stored]);

    expect(mapped.graph.nodes.find((node) => node.id === 'feature:checkout')).toMatchObject({
      kind: 'feature',
      label: 'Checkout',
      provenance: { origin: 'human', actor: 'dev@example.com' },
    });
    expect(mapped.matchedNodes.get('checkout')?.map((node) => node.id)).toEqual([
      'endpoint:create-order',
      'symbol:charge',
    ]);
    expect(mapped.graph.edges.filter((edge) => edge.kind === 'belongs-to-feature')).toHaveLength(2);
  });

  it('registers a feature through the command without replacing existing records', async () => {
    const root = await makeRepo();
    const stdout: string[] = [];
    await runFeatureAddCommand({
      cwd: root,
      id: 'order-history',
      title: 'Order history',
      files: 'src/orders/**,src/shared/order.ts',
      owners: 'orders@example.com',
      recordedBy: 'dev@example.com',
      recordedAt: '2026-08-01T10:00:00.000Z',
      json: true,
      logger: logger(stdout),
    });

    expect(JSON.parse(stdout.join(''))).toMatchObject({
      file: 'docs/.features/order-history.json',
      record: { id: 'order-history', selectors: { files: ['src/orders/**', 'src/shared/order.ts'] } },
    });
    await expect(
      runFeatureAddCommand({
        cwd: root,
        id: 'Bad ID',
        title: 'Bad',
        recordedBy: 'dev@example.com',
        recordedAt: '2026-08-01T10:00:00.000Z',
        logger: logger([]),
      }),
    ).rejects.toThrow(/lowercase kebab-case/);
  });

  it('automatically projects registered features into normal extraction runs', async () => {
    const root = await makeRepo();
    await fs.mkdir(path.join(root, 'src', 'checkout'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'checkout', 'service.ts'), 'export function charge() {}\n');
    await writeNewFeatureRecord(root, record({ selectors: { files: ['src/checkout/**'], nodes: [] } }));

    const config = await loadConfig({ root });
    const run = await runExtraction({ config, logger: logger([]), includeSymbols: true });

    expect(run.graph.nodes.find((node) => node.id === 'feature:checkout')).toBeDefined();
    expect(
      run.graph.edges.some(
        (edge) => edge.kind === 'belongs-to-feature' && edge.to === 'feature:checkout',
      ),
    ).toBe(true);
  });

  it('derives feature introduction and last-change commits from selected files', async () => {
    const root = await makeRepo();
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Docgen Test');
      git('config', 'core.autocrlf', 'false');
    } catch {
      return;
    }
    await fs.mkdir(path.join(root, 'src', 'checkout'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'checkout', 'service.ts'), 'first\n');
    git('add', '.');
    git('commit', '-q', '-m', 'introduce checkout');
    const introducedSha = git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(root, 'src', 'checkout', 'service.ts'), 'second\n');
    git('add', '.');
    git('commit', '-q', '-m', 'change checkout');
    const changedSha = git('rev-parse', 'HEAD');

    const stored: StoredFeatureRecord = { ...record(), sourceFile: 'docs/.features/checkout.json' };
    const history = await deriveFeatureCommitHistory({
      root,
      graph: new EvidenceGraphBuilder().build(),
      record: stored,
    });

    expect(history?.introduced.sha).toBe(introducedSha);
    expect(history?.lastChanged.sha).toBe(changedSha);
    expect(history?.evidenceFiles).toEqual(['src/checkout/service.ts']);
  });
});
