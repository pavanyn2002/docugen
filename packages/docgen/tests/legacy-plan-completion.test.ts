import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_REPLACEMENT_PLAN_FILE } from '../src/config/paths.js';
import { legacyArchivePlanSchema, legacyReplacementPlanSchema, writeLegacyOperationPlans } from '../src/legacy/plans.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('legacy plan write completion', () => {
  it('waits for the sibling write to finish before returning a publication failure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-plan-completion-'));
    roots.push(root);
    const common = { schemaVersion: 1, sourceManifestSha256: 'a'.repeat(64), evidenceGraphSha256: 'b'.repeat(64), plannedAt: '2026-09-30T00:00:00.000Z', documents: [] };
    const plans = {
      replacement: legacyReplacementPlanSchema.parse({ ...common, kind: 'legacy-replacement-plan' }),
      archive: legacyArchivePlanSchema.parse({ ...common, kind: 'legacy-archive-plan' }),
    };
    const error = new Error('replacement publication failed');
    const failedCleanup = signal();
    const siblingStarted = signal();
    const releaseSibling = signal();
    const rename = fs.rename.bind(fs);
    const remove = fs.rm.bind(fs);
    const replacementPath = path.join(root, LEGACY_REPLACEMENT_PLAN_FILE);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === replacementPath) throw error;
      siblingStarted.resolve();
      await releaseSibling.promise;
      await rename(from, to);
    });
    vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      await remove(file, options);
      if (String(file).startsWith(replacementPath)) failedCleanup.resolve();
    });
    let finished = false;
    const result = writeLegacyOperationPlans(root, plans).then(
      (value) => { finished = true; return value; },
      (failure: unknown) => { finished = true; return failure; },
    );
    try {
      await Promise.all([failedCleanup.promise, siblingStarted.promise]);
      await new Promise<void>((done) => setImmediate(done));
      expect(finished).toBe(false);
    } finally {
      releaseSibling.resolve();
      expect(await result).toBe(error);
    }
  });
});
