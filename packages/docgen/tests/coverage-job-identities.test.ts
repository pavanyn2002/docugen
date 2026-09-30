import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { jobsExtractor } from '../src/extract/jobs/index.js';
import { createLogger } from '../src/util/logger.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('duplicate queue worker identities', () => {
  it('gives each worker a unique reproducible id even when declarations share a line', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-duplicate-workers-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'workers.ts'), "import { Worker } from 'bullmq'; new Worker('tasks', handler); new Worker('tasks', handler);\n");
    const context = { root, config: await loadConfig({ root }), logger: createLogger({ level: 'silent' }) };
    const first = await jobsExtractor.run(context);
    const second = await jobsExtractor.run(context);
    expect(first.entries).toHaveLength(2);
    expect(new Set(first.entries.map((entry) => entry.id)).size).toBe(2);
    expect(first.entries).toEqual(second.entries);
  });
});
