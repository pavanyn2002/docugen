import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/load.js';
import { runCheckCommand } from '../src/commands/check.js';
import { runDoctorCommand } from '../src/commands/doctor.js';
import { runExtractCommand } from '../src/commands/extract.js';
import { runExtraction } from '../src/pipeline.js';
import { writeAll } from '../src/render/index.js';
import type { ConfigResult, EndpointsResult } from '../src/types/entries.js';
import { createLogger } from '../src/util/logger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'class-express-payment');
const created: string[] = [];

function captureLogger() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stream = (bucket: string[]): NodeJS.WritableStream =>
    ({ write: (chunk: unknown) => (bucket.push(String(chunk)), true) }) as unknown as NodeJS.WritableStream;
  return { stdout, stderr, logger: createLogger({ level: 'silent', stdout: stream(stdout), stderr: stream(stderr) }) };
}

async function copyFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docugen-class-payment-'));
  created.push(root);
  await fs.cp(FIXTURE, root, { recursive: true });
  return root;
}

async function generatedFiles(root: string): Promise<Record<string, string>> {
  const base = path.join(root, 'docs', 'generated');
  const absoluteFiles: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) await visit(absolute);
      else absoluteFiles.push(absolute);
    }
  };
  await visit(base);
  return Object.fromEntries(await Promise.all(absoluteFiles.sort().map(async (absolute) => [
    path.relative(base, absolute).replaceAll('\\', '/'),
    await fs.readFile(absolute, 'utf8'),
  ])));
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('class-based payment service integration', () => {
  it('generates linked, secret-safe, deterministic documentation that passes check', async () => {
    const root = await copyFixture();
    const capture = captureLogger();
    const firstRun = await runExtraction({ config: await loadConfig({ root }), logger: capture.logger });
    const endpoints = firstRun.results.get('endpoints') as EndpointsResult;
    const config = firstRun.results.get('config') as ConfigResult;

    expect(endpoints.entries.some((entry) => entry.path === '/' && entry.application?.includes('PaymentApp.app'))).toBe(true);
    expect(endpoints.entries.some((entry) => entry.path === '/api/v1/health')).toBe(true);
    expect(endpoints.gaps.filter((gap) => gap.kind === 'router-not-mounted')).toHaveLength(1);
    expect(endpoints.gaps.filter((gap) => gap.kind === 'duplicate-endpoint')).toHaveLength(1);
    expect(endpoints.gaps.filter((gap) => gap.kind === 'openapi-scope-ambiguous')).toHaveLength(0);
    expect(endpoints.openapi).toMatchObject({
      operationsCompared: 6, operationsSkippedAmbiguous: 0, ambiguousDocuments: 0, documentsParsed: 3,
    });
    expect(config.entries.find((entry) => entry.name === 'AUTH_SERVICE_URL')?.defaultValue)
      .toBe("'http://localhost:8001'");

    await writeAll(firstRun);
    const first = await generatedFiles(root);
    const combined = Object.values(first).join('\n');
    expect(combined).toContain('ADMIN_SERVICE_KEY');
    expect(combined).toContain('AUTH_SERVICE_URL');
    expect(combined).toContain('http://localhost:8001');
    for (const forbidden of ['test-service-key', 'test-user-key', 'AKIA1234567890123456']) {
      expect(combined).not.toContain(forbidden);
      expect(JSON.stringify(firstRun.graph)).not.toContain(forbidden);
    }
    expect(first['api.md']).toContain('Operations compared in an applicable runtime');
    expect(first['api.md']).not.toContain('partially cross-checked');

    const json = captureLogger();
    await runExtractCommand({ cwd: root, json: true, dryRun: true, logger: json.logger });
    const jsonText = json.stdout.join('');
    expect(JSON.parse(jsonText).extractors.endpoints.openapi).toMatchObject({
      operationsCompared: 6, operationsSkippedAmbiguous: 0, ambiguousDocuments: 0,
    });
    for (const forbidden of ['test-service-key', 'test-user-key', 'AKIA1234567890123456']) {
      expect(jsonText).not.toContain(forbidden);
      expect(json.stderr.join('')).not.toContain(forbidden);
    }

    const schema = first['schema.md'] ?? '';
    const anchors = [...schema.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1] as string);
    const links = [...schema.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1] as string);
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(links.every((anchor) => anchors.includes(anchor))).toBe(true);

    for (const [relative, markdown] of Object.entries(first).filter(([file]) => file.endsWith('.md'))) {
      const from = path.join(root, 'docs', 'generated', relative);
      for (const match of markdown.matchAll(/\]\(([^)#]+)#L\d+\)/g)) {
        const target = path.resolve(path.dirname(from), decodeURIComponent(match[1] as string));
        await expect(fs.stat(target)).resolves.toBeDefined();
      }
    }

    const secondRun = await runExtraction({ config: await loadConfig({ root }), logger: capture.logger });
    await writeAll(secondRun);
    expect(await generatedFiles(root)).toEqual(first);

    const check = captureLogger();
    await runCheckCommand({ cwd: root, json: true, logger: check.logger });
    expect(JSON.parse(check.stdout.join(''))).toMatchObject({ ok: true, drift: [] });

    const doctor = captureLogger();
    await runDoctorCommand({ cwd: root, json: true, logger: doctor.logger });
    expect(JSON.parse(doctor.stdout.join('')).checks.find((item: { id: string }) => item.id === 'git'))
      .toMatchObject({ gitFailureKind: 'not-repository' });
  });

  it('retains the function-parameter/dynamic-import application pattern', async () => {
    const root = path.join(HERE, 'fixtures', 'express-service');
    const run = await runExtraction({ config: await loadConfig({ root }), logger: captureLogger().logger });
    const endpoints = run.results.get('endpoints') as EndpointsResult;
    expect(endpoints.entries.some((entry) => entry.path === '/health')).toBe(true);
    expect(endpoints.entries.some((entry) => entry.path === '/orders/:orderId')).toBe(true);
    expect(endpoints.gaps.some((gap) => gap.kind === 'router-not-mounted')).toBe(false);
    expect(endpoints.gaps.some((gap) => gap.kind === 'openapi-scope-ambiguous')).toBe(false);
  });
});
