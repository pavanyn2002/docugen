import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveCards } from '../../src/infer/store.js';
import type { FeatureCard } from '../../src/infer/types.js';
import { writeNewFeatureRecord } from '../../src/features/store.js';
import { writeNewPlanRecord } from '../../src/plans/store.js';

export function homeCard(): FeatureCard {
  return {
    surfaceId: 'screen:/', slug: 'home', title: 'Home', kind: 'screen',
    producedBy: 'fixture', inputHash: 'fixture', promptVersion: 'feature-card.v2', answered: [],
    body: {
      summary: { text: 'Shows the home page.', evidence: [{ file: 'app/page.tsx', line: 1 }] },
      userVisibleBehaviour: [], states: [], edgeCases: [],
      unknowns: [
        { id: 'access', question: 'Who can view this page?', why: 'No access policy is visible.', options: ['Everyone', 'Signed-in users'] },
        { id: 'empty', question: 'What happens without data?', why: 'No data contract is visible.', options: [] },
      ],
    },
  };
}

export async function seedGovernance(root: string): Promise<void> {
  await writeNewFeatureRecord(root, {
    schemaVersion: 1, id: 'home', title: 'Home', aliases: ['landing'], status: 'active',
    owners: ['dev@example.com'], criticality: 'high', selectors: { files: ['app/**'], nodes: [] },
    recordedBy: 'dev@example.com', recordedAt: '2026-08-01T00:00:00.000Z',
  });
  await writeNewPlanRecord(root, {
    schemaVersion: 1, id: 'home-update', featureId: 'home', title: 'Update home',
    summary: 'Improve the home page.', status: 'draft',
    acceptanceCriteria: [{ id: 'AC-01', text: 'The home page renders.' }],
    risks: ['Existing links must remain valid.'], testNotes: ['Check navigation.'], transitions: [],
    recordedBy: 'dev@example.com', recordedAt: '2026-08-01T00:00:00.000Z',
  });
  await saveCards(root, [homeCard()]);
}

export async function createRepository(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-command-'));
  try {
    for (const [file, contents] of Object.entries({
      'package.json': JSON.stringify({ name: 'checkout-app', dependencies: { next: '^15.0.0' } }),
      'app/page.tsx': 'export default function Home() { return null; }\n',
      'docgen.config.json': JSON.stringify({ include: ['app/**', 'package.json'] }),
      ...files,
    })) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), contents);
    }
    for (const args of [
      ['init'], ['config', 'user.email', 'dev@example.com'],
      ['config', 'user.name', 'Developer'], ['add', '.'], ['commit', '-m', 'initial'],
    ]) {
      execFileSync('git', [
        '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(root, '.git', 'disabled-hooks')}`, ...args,
      ], { cwd: root, windowsHide: true, stdio: 'pipe', timeout: 15_000 });
    }
    return root;
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}
