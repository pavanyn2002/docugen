import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runHandoffCommand } from '../src/commands/handoff.js';
import { runChangeRecordCommand } from '../src/commands/change.js';
import { runCheckCommand } from '../src/commands/check.js';
import { runIndexGraphCommand } from '../src/commands/index-graph.js';
import { runPlanCreateCommand, runPlanStatusCommand } from '../src/commands/plan.js';
import { runSyncCommand } from '../src/commands/sync.js';
import { mapFeaturesIntoGraph } from '../src/features/graph.js';
import type { FeatureRecord, StoredFeatureRecord } from '../src/features/schema.js';
import { writeNewFeatureRecord } from '../src/features/store.js';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';
import { mapPlansIntoGraph } from '../src/plans/graph.js';
import type { PlanRecord, StoredPlanRecord } from '../src/plans/schema.js';
import { loadPlanRecords, serialisePlanRecord, writeNewPlanRecord } from '../src/plans/store.js';
import type { Logger } from '../src/util/logger.js';

const created: string[] = [];

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-plans-'));
  created.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const feature = (): FeatureRecord => ({
  schemaVersion: 1,
  id: 'checkout',
  title: 'Checkout',
  aliases: ['payments-checkout'],
  status: 'active',
  owners: ['payments@example.com'],
  criticality: 'high',
  selectors: { files: ['src/checkout/**'], nodes: [] },
  recordedBy: 'lead@example.com',
  recordedAt: '2026-08-01T10:00:00.000Z',
});

const plan = (): PlanRecord => ({
  schemaVersion: 1,
  id: 'checkout-retry',
  featureId: 'checkout',
  title: 'Checkout retry handling',
  summary: 'Make failed payment retries visible and safe.',
  status: 'approved',
  acceptanceCriteria: [
    { id: 'AC-01', text: 'A failed payment can be retried once without creating a duplicate order.' },
  ],
  risks: ['Duplicate payment submission.'],
  testNotes: ['Verify the second request reuses the original idempotency key.'],
  transitions: [],
  recordedBy: 'lead@example.com',
  recordedAt: '2026-08-02T10:00:00.000Z',
});

function silentLogger(stdout: string[] = []): Logger {
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

describe('governed plans', () => {
  it('writes plans canonically and projects acceptance criteria into the graph', async () => {
    const root = await makeRepo();
    const file = await writeNewPlanRecord(root, plan());
    const loaded = await loadPlanRecords(root);
    expect(file).toBe('docs/.plans/checkout-retry.json');
    expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(serialisePlanRecord(plan()));
    expect(loaded).toHaveLength(1);

    const storedFeature: StoredFeatureRecord = {
      ...feature(),
      sourceFile: 'docs/.features/checkout.json',
    };
    const storedPlan: StoredPlanRecord = { ...plan(), sourceFile: file };
    const featureGraph = mapFeaturesIntoGraph(new EvidenceGraphBuilder().build(), [storedFeature]).graph;
    const graph = mapPlansIntoGraph(featureGraph, [storedPlan]);

    expect(graph.nodes.find((node) => node.id === 'plan:checkout-retry')).toBeDefined();
    expect(graph.nodes.find((node) => node.id === 'requirement:checkout-retry:AC-01')).toMatchObject({
      kind: 'requirement',
      provenance: { origin: 'human', actor: 'lead@example.com' },
    });
    expect(graph.edges.filter((edge) => edge.kind === 'belongs-to-feature')).toHaveLength(2);
    await expect(writeNewPlanRecord(root, plan())).rejects.toThrow(/already exists/);
  });

  it('creates stable acceptance ids and resolves feature aliases', async () => {
    const root = await makeRepo();
    await writeNewFeatureRecord(root, feature());
    await runPlanCreateCommand({
      cwd: root,
      id: 'retry-rollout',
      feature: 'payments-checkout',
      title: 'Retry rollout',
      summary: 'Release retry handling.',
      acceptance: ['First criterion', 'Second criterion'],
      risks: ['A risk'],
      recordedBy: 'dev@example.com',
      recordedAt: '2026-08-03T10:00:00.000Z',
      logger: silentLogger(),
    });

    const createdPlan = (await loadPlanRecords(root))[0];
    expect(createdPlan?.featureId).toBe('checkout');
    expect(createdPlan?.acceptanceCriteria.map((criterion) => criterion.id)).toEqual(['AC-01', 'AC-02']);

    await runPlanStatusCommand({
      cwd: root,
      id: 'retry-rollout',
      status: 'approved',
      note: 'Product approval',
      changedBy: 'lead@example.com',
      changedAt: '2026-08-04T10:00:00.000Z',
      logger: silentLogger(),
    });
    const approved = (await loadPlanRecords(root))[0];
    expect(approved?.status).toBe('approved');
    expect(approved?.transitions).toEqual([
      {
        from: 'draft',
        to: 'approved',
        changedBy: 'lead@example.com',
        changedAt: '2026-08-04T10:00:00.000Z',
        note: 'Product approval',
      },
    ]);
    await expect(
      runPlanStatusCommand({
        cwd: root,
        id: 'retry-rollout',
        status: 'completed',
        changedBy: 'lead@example.com',
        changedAt: '2026-08-05T10:00:00.000Z',
        logger: silentLogger(),
      }),
    ).rejects.toThrow(/cannot move/);
  });

  it('generates a tester handoff from Git impact and approved human intent', async () => {
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
    await fs.writeFile(path.join(root, 'src', 'checkout', 'service.ts'), 'export function retry() { return false; }\n');
    await writeNewFeatureRecord(root, feature());
    await writeNewPlanRecord(root, plan());
    git('add', '.');
    git('commit', '-q', '-m', 'baseline checkout');
    await runIndexGraphCommand({ cwd: root, logger: silentLogger() });

    await fs.writeFile(path.join(root, 'src', 'checkout', 'service.ts'), 'export function retry() { return true; }\n');
    await runChangeRecordCommand({
      cwd: root,
      id: 'checkout-retry-enabled',
      summary: 'Enable safe checkout retries',
      features: 'payments-checkout',
      plans: 'checkout-retry',
      kind: 'fix',
      recordedBy: 'dev@example.com',
      recordedAt: '2026-08-05T10:00:00.000Z',
      logger: silentLogger(),
    });
    await runSyncCommand({ cwd: root, logger: silentLogger() });
    await runHandoffCommand({ cwd: root, logger: silentLogger() });

    const handoff = await fs.readFile(path.join(root, 'docs/handoffs/tester-handoff.md'), 'utf8');
    expect(handoff).toContain('# Tester handoff');
    expect(handoff).toContain('src/checkout/service.ts');
    expect(handoff).toContain('Checkout (`checkout`)');
    expect(handoff).toContain('**AC-01:** A failed payment can be retried once');
    expect(handoff).toContain('Duplicate payment submission.');
    expect(handoff).toContain('human-owned plan records');

    const featurePage = await fs.readFile(path.join(root, 'docs/generated/features/checkout.md'), 'utf8');
    const planPage = await fs.readFile(path.join(root, 'docs/generated/plans/checkout-retry.md'), 'utf8');
    const changelog = await fs.readFile(path.join(root, 'docs/generated/changelog.md'), 'utf8');
    expect(featurePage).toContain('## Implementation evidence');
    expect(featurePage).toContain('Enable safe checkout retries');
    expect(planPage).toContain('**AC-01:** A failed payment can be retried once');
    expect(changelog).toContain('Enable safe checkout retries');
    expect(changelog).toContain('src/checkout/service.ts');
    await expect(runCheckCommand({ cwd: root, logger: silentLogger() })).resolves.toBeUndefined();
  });
});
