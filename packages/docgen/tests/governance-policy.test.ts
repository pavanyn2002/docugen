import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { writeNewFeatureRecord } from '../src/features/store.js';
import type { FeatureRecord } from '../src/features/schema.js';
import { evaluateGovernance } from '../src/governance/evaluate.js';
import { addGovernanceException } from '../src/governance/store.js';
import type { GovernanceException } from '../src/governance/schema.js';
import { writeNewPlanRecord } from '../src/plans/store.js';
import { runExtraction } from '../src/pipeline.js';
import { recordRequirement } from '../src/requirements/store.js';
import { createLogger } from '../src/util/logger.js';
import { runCheckCommand } from '../src/commands/check.js';
import { runSyncCommand } from '../src/commands/sync.js';

const created: string[] = [];
const logger = createLogger({ level: 'silent' });
const DAY_ONE = new Date('2026-08-12T00:00:00.000Z');

function feature(overrides: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    schemaVersion: 1,
    id: 'checkout',
    title: 'Checkout',
    aliases: [],
    status: 'active',
    owners: ['payments@example.com'],
    criticality: 'high',
    selectors: { files: ['src/**'], nodes: [] },
    recordedBy: 'lead@example.com',
    recordedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

async function makeRepo(policies: Record<string, boolean>, featureOverrides: Partial<FeatureRecord> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-policy-'));
  created.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'policy-fixture' }), 'utf8');
  await fs.writeFile(path.join(root, 'docgen.config.json'), JSON.stringify({ governance: { policies, criticalityAtLeast: 'high' } }), 'utf8');
  await fs.writeFile(path.join(root, 'src', 'checkout.ts'), 'export function checkout() { return true; }\n', 'utf8');
  await writeNewFeatureRecord(root, feature(featureOverrides));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Developer'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
  return root;
}

async function evaluate(root: string, options: { base?: string; now?: Date } = {}) {
  const config = await loadConfig({ root });
  const run = await runExtraction({ config, logger, includeSymbols: true });
  return evaluateGovernance({ config, graph: run.graph, ...(options.base === undefined ? {} : { base: options.base }), now: options.now ?? DAY_ONE });
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('governance policies', () => {
  it('blocks a changed feature with no plan and no current tester handoff', async () => {
    const root = await makeRepo({ changedFeaturesRequirePlan: true, changesRequireHandoff: true });
    await fs.writeFile(path.join(root, 'src', 'checkout.ts'), 'export function checkout() { return false; }\n', 'utf8');
    const report = await evaluate(root, { base: 'HEAD' });
    expect(report.violations.map((item) => item.policy)).toEqual(['changed-feature-plan', 'tester-handoff']);
  });

  it('passes after the plan and exact change handoff exist', async () => {
    const root = await makeRepo({ changedFeaturesRequirePlan: true, changesRequireHandoff: true });
    await fs.writeFile(path.join(root, 'src', 'checkout.ts'), 'export function checkout() { return false; }\n', 'utf8');
    await writeNewPlanRecord(root, {
      schemaVersion: 1, id: 'checkout-change', featureId: 'checkout', title: 'Checkout behavior', summary: 'Change checkout behavior.', status: 'approved', acceptanceCriteria: [{ id: 'AC-01', text: 'Checkout returns the intended result.' }], risks: [], testNotes: [], transitions: [], recordedBy: 'lead@example.com', recordedAt: '2026-08-10T00:00:00.000Z',
    });
    await fs.mkdir(path.join(root, 'docs', 'handoffs'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs', 'handoffs', 'tester-handoff.md'), '# Tester handoff\n\n- Base: `HEAD`\n\n## Changed files (1)\n\n| Status | File | Previous path |\n|---|---|---|\n| modified | `src/checkout.ts` |  |\n', 'utf8');
    await expect(evaluate(root, { base: 'HEAD' })).resolves.toMatchObject({ ok: true, violations: [] });
  });

  it('requires critical features to have owners, matched evidence, and verified behavior', async () => {
    const root = await makeRepo({ criticalFeaturesRequireVerification: true }, { owners: [], selectors: { files: ['missing/**'], nodes: [] }, criticality: 'critical' });
    const report = await evaluate(root);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({ policy: 'critical-feature-verification', subject: 'checkout' });
    expect(report.violations[0]?.message).toContain('has no owner');
    expect(report.violations[0]?.message).toContain('selectors match no code evidence');
  });

  it('blocks requirements without a test citation', async () => {
    const root = await makeRepo({ requirementsRequireTests: true });
    await recordRequirement({ root, surfaceId: 'surface:checkout', slug: 'checkout', kind: 'requirement', title: 'Should checkout', statement: 'Checkout succeeds.', questionId: 'q1', recordedBy: 'dev@example.com', recordedAt: '2026-08-10T00:00:00.000Z' });
    const report = await evaluate(root);
    expect(report.violations).toEqual(expect.arrayContaining([expect.objectContaining({ policy: 'requirement-test-coverage', subject: 'REQ-checkout-01' })]));
  });

  it('enforces enabled policies through the universal check gate', async () => {
    const root = await makeRepo({ requirementsRequireTests: true });
    await recordRequirement({ root, surfaceId: 'surface:checkout', slug: 'checkout', kind: 'requirement', title: 'Should checkout', statement: 'Checkout succeeds.', questionId: 'q1', recordedBy: 'dev@example.com', recordedAt: '2026-08-10T00:00:00.000Z' });
    await runSyncCommand({ cwd: root, logger });
    await expect(runCheckCommand({ cwd: root, asOf: DAY_ONE.toISOString(), logger })).rejects.toMatchObject({ code: 'governance-policy-failed' });
  });
});

describe('time-bounded exceptions', () => {
  it('suppresses only until its expiry and keeps the expired record visible', async () => {
    const root = await makeRepo({ changedFeaturesRequirePlan: true });
    await fs.writeFile(path.join(root, 'src', 'checkout.ts'), 'export function checkout() { return false; }\n', 'utf8');
    const exception: GovernanceException = { id: 'checkout-plan-delay', policy: 'changed-feature-plan', subject: 'checkout', owner: 'lead@example.com', reason: 'Plan review is scheduled.', recordedAt: DAY_ONE.toISOString(), expiresAt: '2026-08-13T00:00:00.000Z' };
    await addGovernanceException({ root, exception, now: DAY_ONE });
    const active = await evaluate(root, { base: 'HEAD', now: DAY_ONE });
    expect(active).toMatchObject({ ok: true, violations: [] });
    expect(active.suppressed).toHaveLength(1);
    const expired = await evaluate(root, { base: 'HEAD', now: new Date('2026-08-14T00:00:00.000Z') });
    expect(expired.ok).toBe(false);
    expect(expired.violations).toHaveLength(1);
    expect(expired.expiredExceptions.map((item) => item.id)).toEqual(['checkout-plan-delay']);
  });

  it('rejects exceptions that are already expired', async () => {
    const root = await makeRepo({});
    await expect(addGovernanceException({ root, now: DAY_ONE, exception: { id: 'past', policy: 'tester-handoff', owner: 'lead@example.com', reason: 'Too late.', recordedAt: DAY_ONE.toISOString(), expiresAt: '2026-08-11T00:00:00.000Z' } })).rejects.toMatchObject({ code: 'governance-exception-expired' });
  });
});
