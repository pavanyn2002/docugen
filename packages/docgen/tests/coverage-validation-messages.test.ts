import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPlanRecords } from '../src/plans/store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('human-owned record validation diagnostics', () => {
  it('reports all invalid fields so developers can repair a plan in one pass', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-invalid-plan-'));
    roots.push(root);
    const directory = path.join(root, 'docs/.plans');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'home.json'), JSON.stringify({
      schemaVersion: 1, id: 'INVALID ID', featureId: 'home', title: 42, summary: 'Home',
      recordedBy: 'dev@example.com', recordedAt: '2026-09-30T00:00:00.000Z',
    }));
    await expect(loadPlanRecords(root)).rejects.toMatchObject({
      code: 'plan-record-invalid',
      message: expect.stringMatching(/must be lowercase kebab-case.*Expected string, received number/),
      file: 'docs/.plans/home.json',
    });
  });
});
