import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectRepositoryHealth } from '../src/commands/doctor.js';
import { runMigrateCommand } from '../src/commands/migrate.js';
import { MIGRATIONS_DIR } from '../src/config/paths.js';
import { applyMigrations, inspectMigrations, rollbackMigration } from '../src/migrations/engine.js';
import { ATOMIC_TEMP_MARKER } from '../src/util/atomic.js';
import { createLogger } from '../src/util/logger.js';

const execFileAsync = promisify(execFile);
const created: string[] = [];

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-migrate-'));
  created.push(root);
  for (const [file, contents] of Object.entries(files)) {
    const absolute = path.join(root, file);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, contents, 'utf8');
  }
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root });
  return root;
}

function featureV0(id = 'checkout'): string {
  return `${JSON.stringify({
    id,
    title: 'Checkout',
    aliases: [],
    status: 'active',
    owners: ['team@example.com'],
    criticality: 'high',
    selectors: { files: ['src/checkout.ts'], nodes: [] },
    recordedBy: 'team@example.com',
    recordedAt: '2026-08-12T00:00:00.000Z',
  }, null, 2)}\n`;
}

function captureLogger() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sink = (target: string[]): NodeJS.WritableStream =>
    ({ write: (chunk: string) => (target.push(chunk), true) }) as unknown as NodeJS.WritableStream;
  return { stdout, stderr, logger: createLogger({ stdout: sink(stdout), stderr: sink(stderr) }) };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('schema migrations', () => {
  it('dry-runs without writes, applies v0 to v1 with a backup, and rolls back exact bytes', async () => {
    const before = featureV0();
    const root = await makeRepo({ 'docs/.features/checkout.json': before });
    const dry = captureLogger();
    await runMigrateCommand({ cwd: root, dryRun: true, json: true, logger: dry.logger });
    expect(JSON.parse(dry.stdout.join(''))).toMatchObject({ pending: 1 });
    await expect(fs.readFile(path.join(root, 'docs/.features/checkout.json'), 'utf8')).resolves.toBe(before);

    const receipt = await applyMigrations(root, { now: new Date('2026-08-12T01:02:03.000Z') });
    expect(receipt?.changes).toHaveLength(1);
    const migrated = JSON.parse(await fs.readFile(path.join(root, 'docs/.features/checkout.json'), 'utf8')) as { schemaVersion: number };
    expect(migrated.schemaVersion).toBe(1);
    await expect(fs.readFile(path.join(root, receipt!.changes[0]!.backupFile), 'utf8')).resolves.toBe(before);
    expect((await inspectMigrations(root)).map((item) => item.status)).toEqual(['current']);

    const rolledBack = await rollbackMigration(root, receipt!.id, { now: new Date('2026-08-12T02:00:00.000Z') });
    expect(rolledBack.rolledBackAt).toBe('2026-08-12T02:00:00.000Z');
    await expect(fs.readFile(path.join(root, 'docs/.features/checkout.json'), 'utf8')).resolves.toBe(before);
  });

  it('refuses rollback after a human edit and preserves the edit', async () => {
    const root = await makeRepo({ 'docs/.features/checkout.json': featureV0() });
    const receipt = await applyMigrations(root);
    const file = path.join(root, 'docs/.features/checkout.json');
    const edited = (await fs.readFile(file, 'utf8')).replace('Checkout', 'Edited checkout');
    await fs.writeFile(file, edited, 'utf8');
    await expect(rollbackMigration(root, receipt!.id)).rejects.toMatchObject({ code: 'migration-rollback-conflict' });
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(edited);
  });

  it('blocks unsupported future versions without creating migration state', async () => {
    const future = featureV0().replace('{', '{\n  "schemaVersion": 99,');
    const root = await makeRepo({ 'docs/.features/checkout.json': future });
    await expect(applyMigrations(root)).rejects.toMatchObject({ code: 'migration-blocked' });
    await expect(fs.stat(path.join(root, MIGRATIONS_DIR))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(root, 'docs/.features/checkout.json'), 'utf8')).resolves.toBe(future);
  });
});

describe('docgen doctor', () => {
  it('reports pending schemas and only removes stale Docgen temporary files with --fix', async () => {
    const root = await makeRepo({
      'docs/.features/checkout.json': featureV0(),
      'docgen.pilot.json': `${JSON.stringify({
        schemaVersion: 1,
        repository: 'doctor-fixture',
        repositoryClass: 'library',
        reviewStatus: 'draft',
        reviewedBy: 'maintainer@example.com',
        reviewedAt: '2026-08-12T00:00:00.000Z',
        expectations: { technologies: [], graphGaps: [] },
      }, null, 2)}\n`,
    });
    const stale = path.join(root, `state.json${ATOMIC_TEMP_MARKER}stale`);
    const current = path.join(root, `state.json${ATOMIC_TEMP_MARKER}current`);
    const unrelated = path.join(root, 'state.json.tmp');
    await Promise.all([fs.writeFile(stale, 'x'), fs.writeFile(current, 'x'), fs.writeFile(unrelated, 'x')]);
    await fs.utimes(stale, new Date(0), new Date(0));

    const before = await inspectRepositoryHealth({ cwd: root, logger: captureLogger().logger });
    expect(before.ok).toBe(true);
    expect(before.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'schemas', status: 'warn' }),
      expect.objectContaining({ id: 'interrupted-writes', status: 'warn' }),
      expect.objectContaining({ id: 'pilot-evidence', status: 'warn' }),
    ]));

    const fixed = await inspectRepositoryHealth({ cwd: root, fix: true, logger: captureLogger().logger });
    expect(fixed.checks).toContainEqual(expect.objectContaining({ id: 'interrupted-writes', status: 'fixed' }));
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(current, 'utf8')).resolves.toBe('x');
    await expect(fs.readFile(unrelated, 'utf8')).resolves.toBe('x');
  });

  it('fails when configured pilot evidence is malformed', async () => {
    const root = await makeRepo({ 'docgen.pilot.json': '{"schemaVersion":99}\n' });
    const report = await inspectRepositoryHealth({ cwd: root, logger: captureLogger().logger });
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'pilot-evidence', status: 'fail' }));
  });
});
