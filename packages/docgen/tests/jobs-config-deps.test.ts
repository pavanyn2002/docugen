import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobsExtractor } from '../src/extract/jobs/index.js';
import { parseCodeJobs } from '../src/extract/jobs/code-jobs.js';
import { parseWorkflowSchedules } from '../src/extract/jobs/manifests.js';
import { configExtractor, isSecretLike } from '../src/extract/config/index.js';
import { depsExtractor, findCycles, packageNameOf } from '../src/extract/deps/index.js';
import { loadConfig } from '../src/config/load.js';
import type { ConfigResult, DepsResult, JobsResult, ModuleEntry } from '../src/types/entries.js';
import type { Extractor } from '../src/extract/types.js';
import { createLogger } from '../src/util/logger.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(TEST_DIR, 'fixtures');

const silent = createLogger({
  level: 'silent',
  stderr: { write: () => true } as unknown as NodeJS.WritableStream,
  stdout: { write: () => true } as unknown as NodeJS.WritableStream,
});

async function run<T>(extractor: Extractor<never>, root: string): Promise<T> {
  const config = await loadConfig({ root });
  return (await extractor.run({ root: config.root, config, logger: silent })) as T;
}

const jobs = (root: string) => run<JobsResult>(jobsExtractor as never, root);
const conf = (root: string) => run<ConfigResult>(configExtractor as never, root);
const deps = (root: string) => run<DepsResult>(depsExtractor as never, root);

// ── jobs ─────────────────────────────────────────────────────────────────────

describe('background jobs', () => {
  it('extracts an amqplib consumer with its queue', async () => {
    const result = await jobs(path.join(FIXTURES, 'jobs-service'));
    const consumer = result.entries.find((entry) => entry.name === 'order.created');

    expect(consumer).toMatchObject({ kind: 'queue-consumer', channel: 'order.created', runtime: 'amqplib' });
  });

  // Naming a queue after the expression that holds it would put a queue in the
  // docs that does not exist.
  it('reports a consumer whose queue name is not a literal', async () => {
    const result = await jobs(path.join(FIXTURES, 'jobs-service'));
    const gap = result.gaps.find((g) => g.kind === 'queue-name-not-literal');

    expect(gap?.message).toContain('QueueName.DEAD_LETTER');
    // The consumer still exists, so it is recorded — only its queue is unknown.
    expect(result.entries.some((entry) => entry.name.startsWith('consumer at'))).toBe(true);
  });

  it('extracts a BullMQ worker', async () => {
    const result = await jobs(path.join(FIXTURES, 'jobs-service'));
    expect(result.entries.find((entry) => entry.name === 'email-notifications')).toMatchObject({
      kind: 'queue-consumer',
      runtime: 'bullmq',
    });
  });

  // A Queue is a producer handle; recording it as a job would tell a reader
  // that code executes where none does.
  it('does not report a queue with no worker as a running job', async () => {
    const result = await jobs(path.join(FIXTURES, 'jobs-service'));
    expect(result.entries.some((entry) => entry.name === 'nightly-reports')).toBe(false);
  });

  it('reports a queue that no local worker consumes', async () => {
    const result = await jobs(path.join(FIXTURES, 'jobs-service'));
    const gap = result.gaps.find((g) => g.kind === 'queue-without-local-worker');

    expect(gap?.message).toContain('nightly-reports');
  });

  it('retains the literal Bull queue channel for process consumers', () => {
    const result = parseCodeJobs(
      'worker.ts',
      "import Bull from 'bull';\nconst mail = new Bull('mail');\nmail.process(handleMail);\n",
    );

    expect(result.entries).toEqual([
      expect.objectContaining({ name: 'mail', channel: 'mail', runtime: 'bull' }),
    ]);
  });

  it('extracts a node-cron schedule', async () => {
    const result = await jobs(path.join(FIXTURES, 'jobs-service'));
    expect(result.entries.find((entry) => entry.schedule === '*/15 * * * *')).toMatchObject({
      kind: 'cron',
      runtime: 'node-cron',
    });
  });

  it('extracts a named node-schedule job', async () => {
    const result = await jobs(path.join(FIXTURES, 'jobs-service'));
    expect(result.entries.find((entry) => entry.name === 'reconcile')).toMatchObject({
      schedule: '0 2 * * *',
      runtime: 'node-schedule',
    });
  });

  it('reports a schedule that is not a literal', async () => {
    const result = await jobs(path.join(FIXTURES, 'jobs-service'));
    expect(result.gaps.some((g) => g.kind === 'job-trigger-not-literal')).toBe(true);
  });

  // A CI cron touches production and appears nowhere in application source.
  it('extracts GitHub Actions schedules', async () => {
    const result = await jobs(path.join(FIXTURES, 'jobs-service'));
    const gha = result.entries.filter((entry) => entry.runtime === 'github-actions');

    expect(gha.map((entry) => entry.schedule).sort()).toEqual(['0 3 * * *', '30 5 * * 1']);
    expect(gha[0]?.name).toBe('Nightly maintenance');
  });

  it('extracts Vercel crons', async () => {
    const result = await jobs(path.join(FIXTURES, 'jobs-service'));
    expect(result.entries.find((entry) => entry.runtime === 'vercel-cron')).toMatchObject({
      name: '/api/cron/digest',
      schedule: '0 9 * * *',
    });
  });

  it('stops reading schedules at the end of the block', () => {
    const schedules = parseWorkflowSchedules(
      'on:\n  schedule:\n    - cron: "0 1 * * *"\n  push:\n    branches: [main]\n',
    );
    expect(schedules).toEqual(['0 1 * * *']);
  });

  it('is inapplicable in a repo with no background work', async () => {
    const result = await jobs(path.join(FIXTURES, 'plain-node'));
    expect(result.applicable).toBe(false);
  });
});

// ── config ───────────────────────────────────────────────────────────────────

describe('environment configuration', () => {
  it('reads process.env access in both property and index form', async () => {
    const result = await conf(path.join(FIXTURES, 'config-app'));
    const names = result.entries.map((entry) => entry.name);

    expect(names).toEqual(expect.arrayContaining(['PORT', 'DATABASE_URL', 'STRIPE_SECRET_KEY']));
  });

  it('ignores a lowercase property, which is not an env var convention', async () => {
    const result = await conf(path.join(FIXTURES, 'config-app'));
    expect(result.entries.some((entry) => entry.name === 'lowercase_ignored')).toBe(false);
  });

  it('captures a literal fallback as the default', async () => {
    const result = await conf(path.join(FIXTURES, 'config-app'));

    expect(result.entries.find((entry) => entry.name === 'PORT')?.defaultValue).toBe('3000');
    expect(result.entries.find((entry) => entry.name === 'AWS_REGION')?.defaultValue).toBe("'ap-south-1'");
  });

  it('reads Python environment access', async () => {
    const result = await conf(path.join(FIXTURES, 'config-app'));
    const names = result.entries.map((entry) => entry.name);

    expect(names).toEqual(expect.arrayContaining(['QUEUE_URL', 'LOG_LEVEL', 'REQUEST_TIMEOUT']));
  });

  it('records declarations from .env files with their line', async () => {
    const result = await conf(path.join(FIXTURES, 'config-app'));
    const declared = result.entries.find((entry) => entry.name === 'DATABASE_URL');

    expect(declared?.declarations[0]?.file).toBe('.env.example');
    expect(declared?.declarations[0]?.line).toBeGreaterThan(0);
  });

  it('reads an exported declaration', async () => {
    const result = await conf(path.join(FIXTURES, 'config-app'));
    expect(result.entries.find((entry) => entry.name === 'QUEUE_URL')?.declarations).toHaveLength(1);
  });

  // SPEC 6.4 — the two gap lists that surface real rot immediately.
  it('reports a variable declared but never read', async () => {
    const result = await conf(path.join(FIXTURES, 'config-app'));
    const gap = result.gaps.find((g) => g.kind === 'env-declared-never-read');

    expect(gap?.message).toContain('UNUSED_LEGACY_FLAG');
  });

  it('reports a variable read but never declared', async () => {
    const result = await conf(path.join(FIXTURES, 'config-app'));
    const gap = result.gaps.find((g) => g.kind === 'env-read-never-declared');

    expect(gap?.message).toContain('AWS_REGION');
  });

  // A .env file is full of credentials. Copying one into committed markdown
  // would be a security incident, so values are never read.
  it('never records a value from a .env file', async () => {
    const result = await conf(path.join(FIXTURES, 'config-app'));
    const serialised = JSON.stringify(result);

    expect(serialised).not.toContain('sk_test_donotcopy');
    expect(serialised).not.toContain('postgres://localhost/app');
  });

  it('flags secret-shaped names', async () => {
    const result = await conf(path.join(FIXTURES, 'config-app'));
    expect(result.entries.find((entry) => entry.name === 'STRIPE_SECRET_KEY')?.isSecretLike).toBe(true);
    expect(result.entries.find((entry) => entry.name === 'PORT')?.isSecretLike).toBe(false);
  });

  it.each(['API_KEY', 'DB_PASSWORD', 'JWT_SECRET', 'PRIVATE_KEY', 'SENTRY_DSN'])(
    'treats %s as secret-shaped',
    (name) => {
      expect(isSecretLike(name)).toBe(true);
    },
  );

  it.each(['AWS_ACCESS_KEY_ID', 'ACCESS_KEY', 'ACCESS_KEY_ID', 'CERTIFICATE', 'CONNECTION_STRING'])(
    'treats %s as a secret-shaped name whose default must be suppressed',
    (name) => expect(isSecretLike(name)).toBe(true),
  );

  it('never retains a secret-like or credential-shaped source fallback', async () => {
    const result = await conf(path.join(FIXTURES, 'multi-service'));
    const aws = result.entries.find((entry) => entry.name === 'AWS_ACCESS_KEY_ID');
    expect(aws).toBeDefined();
    expect(aws).not.toHaveProperty('defaultValue');
    expect(JSON.stringify(result)).not.toContain('AKIA1234567890123456');
  });
});

// ── deps ─────────────────────────────────────────────────────────────────────

describe('module dependency graph', () => {
  it('records internal imports as edges', async () => {
    const result = await deps(path.join(FIXTURES, 'deps-app'));
    const a = result.entries.find((entry) => entry.module === 'src/a.ts');

    expect(a?.imports).toContain('src/b.ts');
  });

  it('records external packages separately from internal modules', async () => {
    const result = await deps(path.join(FIXTURES, 'deps-app'));
    const a = result.entries.find((entry) => entry.module === 'src/a.ts');

    expect(a?.externals).toContain('express');
    expect(a?.imports.some((value) => value === 'express')).toBe(false);
  });

  it('detects a cycle and reports it in canonical order', async () => {
    const result = await deps(path.join(FIXTURES, 'deps-app'));

    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('reports the cycle as a gap', async () => {
    const result = await deps(path.join(FIXTURES, 'deps-app'));
    expect(result.gaps.some((gap) => gap.kind === 'import-cycle')).toBe(true);
  });

  // Naming the specifiers is what makes this actionable: a missing directory is
  // a real defect, a JSON fixture is noise, and only the reader can tell.
  it('names the imports that did not resolve', async () => {
    const result = await deps(path.join(FIXTURES, 'deps-app'));
    const gap = result.gaps.find((g) => g.kind === 'import-unresolved');

    expect(gap?.message).toContain('./does-not-exist');
  });

  it('does not report a stylesheet import as unresolved', async () => {
    const result = await deps(path.join(FIXTURES, 'deps-app'));
    const gap = result.gaps.find((g) => g.kind === 'import-unresolved');

    expect(gap?.message).not.toContain('.css');
  });

  it.each([
    ['@scope/pkg/deep/path', '@scope/pkg'],
    ['lodash/fp', 'lodash'],
    ['express', 'express'],
  ])('reduces %s to package %s', (specifier, expected) => {
    expect(packageNameOf(specifier)).toBe(expected);
  });

  it('returns no cycles for an acyclic graph', () => {
    const entries = [
      { module: 'a', imports: ['b'] },
      { module: 'b', imports: ['c'] },
      { module: 'c', imports: [] },
    ] as unknown as readonly ModuleEntry[];

    expect(findCycles(entries)).toEqual([]);
  });

  it('reports a self-import as a cycle', () => {
    const entries = [{ module: 'a', imports: ['a'] }] as unknown as readonly ModuleEntry[];
    expect(findCycles(entries)).toEqual([['a']]);
  });

  it('reports each cycle once regardless of entry point', () => {
    const entries = [
      { module: 'a', imports: ['b'] },
      { module: 'b', imports: ['a'] },
      { module: 'z', imports: ['a'] },
    ] as unknown as readonly ModuleEntry[];

    expect(findCycles(entries)).toHaveLength(1);
  });
});

// ── determinism ──────────────────────────────────────────────────────────────

describe('determinism', () => {
  it.each([
    ['jobs', 'jobs-service'],
    ['config', 'config-app'],
    ['deps', 'deps-app'],
  ])('%s is byte-identical across runs', async (id, fixture) => {
    const root = path.join(FIXTURES, fixture);
    const extractor = { jobs, config: conf, deps }[id as 'jobs' | 'config' | 'deps'];
    const strip = (result: unknown): string =>
      JSON.stringify({ ...(result as Record<string, unknown>), durationMs: 0 });

    expect(strip(await extractor(root))).toBe(strip(await extractor(root)));
  });
});
