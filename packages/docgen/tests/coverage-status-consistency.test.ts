import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { collectStatus } from '../src/status/collect.js';
import { runSyncCommand } from '../src/commands/sync.js';
import { createLogger } from '../src/util/logger.js';
import { createRepository, seedGovernance } from './helpers/repository.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('governed documentation status', () => {
  it('reports no drift after synchronization in a repository with feature evidence', async () => {
    const root = await createRepository();
    roots.push(root);
    await seedGovernance(root);
    const logger = createLogger({ level: 'silent' });
    await runSyncCommand({ cwd: root, logger });
    expect(await collectStatus({ cwd: root, logger })).toMatchObject({
      driftingFiles: 0,
      graph: { features: 1, plans: 1 },
    });
  });
});
