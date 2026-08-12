import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/load.js';
import { runExtraction } from '../src/pipeline.js';
import { writeAll } from '../src/render/index.js';
import { runCheckCommand } from '../src/commands/check.js';
import { runExtractCommand } from '../src/commands/extract.js';
import { inspectRepositoryHealth, runDoctorCommand } from '../src/commands/doctor.js';
import { createLogger } from '../src/util/logger.js';
import type { ConfigResult, EndpointsResult, SchemaResult } from '../src/types/entries.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'multi-service');
const created: string[] = [];

function captureLogger() {
  const stdout: string[] = [];
  const stream = (bucket: string[]): NodeJS.WritableStream =>
    ({ write: (chunk: unknown) => (bucket.push(String(chunk)), true) }) as unknown as NodeJS.WritableStream;
  return {
    stdout,
    logger: createLogger({ level: 'silent', stdout: stream(stdout), stderr: stream([]) }),
  };
}

async function copyFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docugen-multi-service-'));
  created.push(root);
  await fs.cp(FIXTURE, root, { recursive: true });
  return root;
}

async function generatedBytes(root: string): Promise<Record<string, string>> {
  const directory = path.join(root, 'docs', 'generated');
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const item of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, item.name);
      if (item.isDirectory()) await walk(absolute);
      else files.push(absolute);
    }
  }
  await walk(directory);
  return Object.fromEntries(
    await Promise.all(files.sort().map(async (file) => [path.relative(directory, file), await fs.readFile(file, 'utf8')])),
  );
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('multi-service ownership integration', () => {
  it('keeps endpoints, OpenAPI, schema, and config inside their owning workspace', async () => {
    const root = await copyFixture();
    const { logger } = captureLogger();
    const run = await runExtraction({ config: await loadConfig({ root }), logger });
    const endpoints = run.results.get('endpoints') as EndpointsResult;
    const schema = run.results.get('schema') as SchemaResult;
    const config = run.results.get('config') as ConfigResult;

    const health = endpoints.entries.filter((entry) => entry.method === 'GET' && entry.path === '/health');
    expect(health).toHaveLength(3);
    expect(new Set(health.map((entry) => entry.workspace))).toEqual(new Set(['service-a', 'service-b']));
    const duplicate = endpoints.gaps.filter((gap) => gap.kind === 'duplicate-endpoint');
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]?.message).toContain('service-a');
    expect(duplicate[0]?.message).not.toContain('service-b/src/app.ts');

    const unmounted = endpoints.entries.filter((entry) => entry.path === '/relative');
    expect(unmounted).toHaveLength(2);
    expect(unmounted.every((entry) => entry.finalPathResolved === false)).toBe(true);
    expect(endpoints.gaps.filter((gap) => gap.kind === 'router-not-mounted')).toHaveLength(2);
    expect(endpoints.gaps.some((gap) => gap.kind === 'endpoint-not-in-spec')).toBe(false);
    expect(endpoints.gaps.some((gap) => gap.kind === 'spec-endpoint-not-in-code')).toBe(false);

    expect(schema.gaps.filter((gap) => gap.kind === 'duplicate-table-definition')).toHaveLength(2);
    expect(schema.gaps.filter((gap) => gap.kind === 'cross-workspace-schema-name-collision')).toHaveLength(3);

    const database = config.entries.filter((entry) => entry.name === 'DATABASE_URL');
    expect(database).toHaveLength(2);
    expect(database.find((entry) => entry.workspace === 'service-a')?.declarations).toHaveLength(1);
    expect(database.find((entry) => entry.workspace === 'service-b')?.declarations).toHaveLength(0);
    expect(config.gaps.find((gap) => gap.kind === 'env-read-never-declared')?.message).toContain(
      'service-b:DATABASE_URL',
    );

    const aws = config.entries.find((entry) => entry.name === 'AWS_ACCESS_KEY_ID');
    expect(aws).toMatchObject({ isSecretLike: true, workspace: 'service-a' });
    expect(aws).not.toHaveProperty('defaultValue');
    expect(JSON.stringify(run.graph)).not.toContain('AKIA1234567890123456');

    const json = captureLogger();
    await runExtractCommand({ cwd: root, json: true, dryRun: true, logger: json.logger });
    const ownership = JSON.parse(json.stdout.join('')).extractors.endpoints.ownership;
    expect(ownership.some((entry: { workspace?: string }) => entry.workspace === 'service-a')).toBe(true);
    expect(ownership.some((entry: { workspace?: string }) => entry.workspace === 'service-b')).toBe(true);
  });

  it('renders unique anchors, valid links, no secret literals, and byte-identical reruns', async () => {
    const root = await copyFixture();
    const { logger } = captureLogger();
    const firstRun = await runExtraction({ config: await loadConfig({ root }), logger });
    await writeAll(firstRun);
    const first = await generatedBytes(root);
    const combined = Object.values(first).join('\n');
    expect(combined).toContain('AWS_ACCESS_KEY_ID');
    expect(combined).not.toContain('AKIA1234567890123456');

    const schema = first['schema.md'] ?? '';
    const anchors = [...schema.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1]);
    const anchorLinks = [...schema.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1]);
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(anchorLinks).toHaveLength(anchors.length);
    expect(anchorLinks.every((anchor) => anchors.includes(anchor))).toBe(true);

    for (const [relative, markdown] of Object.entries(first).filter(([file]) => file.endsWith('.md'))) {
      const from = path.join(root, 'docs', 'generated', relative);
      for (const match of markdown.matchAll(/\]\(([^)#]+)#L\d+\)/g)) {
        const target = path.resolve(path.dirname(from), decodeURIComponent(match[1] as string));
        await expect(fs.stat(target)).resolves.toBeDefined();
      }
    }

    const secondRun = await runExtraction({ config: await loadConfig({ root }), logger });
    await writeAll(secondRun);
    expect(await generatedBytes(root)).toEqual(first);

    const check = captureLogger();
    await runCheckCommand({ cwd: root, json: true, logger: check.logger });
    expect(JSON.parse(check.stdout.join(''))).toMatchObject({ ok: true, drift: [] });
  });

  it('returns a precise non-repository Git diagnostic without blocking extraction', async () => {
    const root = await copyFixture();
    const { logger } = captureLogger();
    const report = await inspectRepositoryHealth({ cwd: root, json: true, logger });
    expect(report.checks.find((check) => check.id === 'git')).toMatchObject({
      status: 'warn',
      gitFailureKind: 'not-repository',
    });
    const json = captureLogger();
    await runDoctorCommand({ cwd: root, json: true, logger: json.logger });
    expect(JSON.parse(json.stdout.join('')).checks.find((check: { id: string }) => check.id === 'git'))
      .toMatchObject({ gitFailureKind: 'not-repository' });
  });
});
