import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectStatus } from '../src/status/collect.js';
import { renderFleetPage } from '../src/status/render.js';
import { runFleetCommand } from '../src/commands/fleet.js';
import { runSyncCommand } from '../src/commands/sync.js';
import { createLogger } from '../src/util/logger.js';
import { DocgenError } from '../src/util/errors.js';
import type { RepoStatus } from '../src/status/collect.js';

const created: string[] = [];
const quiet = createLogger({ level: 'error' });

async function makeRepo(extra: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-status-'));
  created.push(dir);

  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', dependencies: { next: '^15.0.0' } }),
    'app/page.tsx': 'export default function Home() {\n  return null;\n}\n',
    ...extra,
  };
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function status(overrides: Partial<RepoStatus> = {}): RepoStatus {
  return {
    name: 'app',
    root: '/repos/app',
    engineVersion: '0.1.0',
    surfaces: 10,
    described: 0,
    openQuestions: 0,
    answered: 0,
    untriaged: 0,
    requirements: { requirement: 0, bug: 0, decision: 0, context: 0 },
    testable: 0,
    tested: 0,
    untestedRequirements: 0,
    danglingReferences: 0,
    untracedSurfaces: 0,
    driftingFiles: 0,
    unsupportedTechnologies: [],
    graph: { nodes: 0, edges: 0, gaps: 0, features: 0, criticalFeatures: 0, plans: 0, changes: 0 },
    ...overrides,
  };
}

describe('collecting status', () => {
  it('reports surfaces found and none described before bootstrap', async () => {
    const root = await makeRepo();
    const result = await collectStatus({ cwd: root, logger: quiet });

    expect(result.surfaces).toBeGreaterThan(0);
    expect(result.described).toBe(0);
    expect(result.openQuestions).toBe(0);
    expect(result.graph.nodes).toBeGreaterThan(0);
  });

  it('reports drift before anything has been generated', async () => {
    const root = await makeRepo();
    expect((await collectStatus({ cwd: root, logger: quiet })).driftingFiles).toBeGreaterThan(0);
  });

  it('reports no drift once sync has run', async () => {
    const root = await makeRepo();
    await runSyncCommand({ cwd: root, json: false, logger: quiet });

    expect((await collectStatus({ cwd: root, logger: quiet })).driftingFiles).toBe(0);
  });

  it('refuses a path that is not a directory rather than reporting an empty repo', async () => {
    // A mistyped --cwd otherwise looks exactly like a repo with no routes.
    await expect(
      collectStatus({ cwd: path.join(os.tmpdir(), 'docgen-definitely-missing'), logger: quiet }),
    ).rejects.toThrow(DocgenError);
  });
});

describe('the fleet page', () => {
  it('pairs every count with what it is a count of', () => {
    const page = renderFleetPage({
      repos: [status({ surfaces: 40, described: 6 })],
      failures: [],
      generatedAt: '2026-03-01T00:00:00.000Z',
    });

    expect(page).toContain('**6 of 40 surfaces** have been described at all.');
  });

  it('names the next action per repository', () => {
    const page = renderFleetPage({
      repos: [
        status({ name: 'a', described: 0, surfaces: 5 }),
        status({ name: 'b', described: 5, surfaces: 5, openQuestions: 3 }),
        status({ name: 'c', described: 5, surfaces: 5, untriaged: 2 }),
        status({ name: 'd', driftingFiles: 4 }),
      ],
      failures: [],
      generatedAt: '2026-03-01T00:00:00.000Z',
    });

    expect(page).toContain('`a`: run `docgen bootstrap`');
    expect(page).toContain('`b`: 3 question(s) waiting');
    expect(page).toContain('`c`: 2 answer(s) to classify');
    expect(page).toContain('`d`: run `docgen sync`');
  });

  it('lists a repo it could not read rather than omitting it', () => {
    const page = renderFleetPage({
      repos: [],
      failures: [{ path: '/repos/gone', reason: 'Not a directory' }],
      generatedAt: '2026-03-01T00:00:00.000Z',
    });

    expect(page).toContain('Could not be read');
    expect(page).toContain('/repos/gone');
  });

  it('flags repos whose counts are lower bounds', () => {
    const page = renderFleetPage({
      repos: [status({ unsupportedTechnologies: ['FastAPI'] })],
      failures: [],
      generatedAt: '2026-03-01T00:00:00.000Z',
    });

    expect(page).toContain('Known-incomplete coverage');
    expect(page).toContain('FastAPI');
  });

  it('says nothing about incompleteness when everything parsed', () => {
    const page = renderFleetPage({
      repos: [status()],
      failures: [],
      generatedAt: '2026-03-01T00:00:00.000Z',
    });

    expect(page).not.toContain('Known-incomplete coverage');
  });

  it('orders repositories deterministically', () => {
    const page = renderFleetPage({
      repos: [status({ name: 'zebra' }), status({ name: 'alpha' })],
      failures: [],
      generatedAt: '2026-03-01T00:00:00.000Z',
    });

    expect(page.indexOf('| alpha |')).toBeLessThan(page.indexOf('| zebra |'));
  });

  it('renders the same bytes for the same input', () => {
    const args = {
      repos: [status()],
      failures: [],
      generatedAt: '2026-03-01T00:00:00.000Z',
    } as const;
    expect(renderFleetPage(args)).toBe(renderFleetPage(args));
  });

  it('summarizes graph and governed-record coverage without inventing a score', () => {
    const page = renderFleetPage({
      repos: [
        status({
          graph: {
            nodes: 120,
            edges: 240,
            gaps: 3,
            features: 8,
            criticalFeatures: 2,
            plans: 5,
            changes: 11,
          },
        }),
      ],
      failures: [],
      generatedAt: '2026-08-12T00:00:00.000Z',
    });
    expect(page).toContain('**120 nodes**');
    expect(page).toContain('| app | 120 | 240 | 3 | 8 | 2 | 5 | 11 |');
    expect(page).not.toContain('score');
  });
});

describe('docgen fleet', () => {
  it('writes a dashboard covering every readable repo', async () => {
    const one = await makeRepo();
    const two = await makeRepo();
    const out = path.join(one, 'fleet.md');

    await runFleetCommand({ paths: [one, two], out, json: false, logger: quiet });

    const contents = await fs.readFile(out, 'utf8');
    expect(contents).toContain('from 2 repositories');
  });

  it('keeps going when one repo cannot be read, and says which', async () => {
    const good = await makeRepo();
    const missing = path.join(os.tmpdir(), 'docgen-fleet-missing');
    const out = path.join(good, 'fleet.md');

    await runFleetCommand({ paths: [good, missing], out, json: false, logger: quiet });

    const contents = await fs.readFile(out, 'utf8');
    expect(contents).toContain('from 1 repository');
    expect(contents).toContain('Could not be read');
    expect(contents).toContain('docgen-fleet-missing');
  });
});
