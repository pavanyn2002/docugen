import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluatePilot, renderPilotReport } from '../src/pilot/evaluate.js';
import { createLogger } from '../src/util/logger.js';

const created: string[] = [];
afterEach(async () => Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function repo(manifest: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-pilot-'));
  created.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }), 'utf8');
  await fs.writeFile(path.join(root, 'src/app.ts'), "import express from 'express';\nconst app = express();\napp.get('/health', (_req, res) => res.send('ok'));\n", 'utf8');
  await fs.writeFile(path.join(root, 'docgen.pilot.json'), JSON.stringify(manifest), 'utf8');
  return root;
}

const logger = createLogger({ level: 'silent' });

describe('pilot quality protocol', () => {
  it('records human-reviewed false positives and negatives deterministically', async () => {
    const root = await repo({
      schemaVersion: 1,
      repository: 'express-pilot',
      repositoryClass: 'backend',
      reviewStatus: 'approved',
      reviewedBy: 'reviewer@example.com',
      reviewedAt: '2026-08-12T00:00:00.000Z',
      expectations: {
        technologies: [
          { id: 'express', expected: true, owner: 'reviewer@example.com', note: 'Declared runtime framework.' },
          { id: 'fastapi', expected: true, owner: 'reviewer@example.com', note: 'Deliberate false-negative check.' },
        ],
        graphGaps: [{ id: 'routes:invented-gap', expected: false, owner: 'reviewer@example.com', note: 'Must not be emitted.' }],
      },
    });
    const report = await evaluatePilot({ root, logger });
    expect(report.quality.technologies).toMatchObject({ truePositives: 1, falseNegatives: 1 });
    expect(report.observed.technologies).toContain('express');
    expect(renderPilotReport(report)).toContain('Human-reviewed quality');
    expect(renderPilotReport(report)).toBe(renderPilotReport(report));
  });

  it('rejects unattributed expectation manifests', async () => {
    const root = await repo({ schemaVersion: 1, repository: 'bad' });
    await expect(evaluatePilot({ root, logger })).rejects.toMatchObject({ code: 'pilot-manifest-invalid' });
  });
});
