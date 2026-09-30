import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations, inspectMigrations, rollbackMigration } from '../src/migrations/engine.js';
import { GOVERNANCE_EXCEPTIONS_FILE, LEGACY_MIGRATION_FILE, MIGRATIONS_DIR } from '../src/config/paths.js';

const roots: string[] = [];
const date = '2026-08-12T00:00:00.000Z';
const feature = (id: string) => ({ id, title: id, recordedBy: 'owner', recordedAt: date });
async function repo(files: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-core-migration-'));
  roots.push(root);
  for (const [file, value] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), JSON.stringify(value));
  }
  return root;
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('migration integrity and publication failure recovery', () => {
  it.each([null, 'string', [], { schemaVersion: '1' }, { schemaVersion: -1 }, { schemaVersion: 0.5 }, { schemaVersion: 1 }])('rejects malformed artifact %j without publishing', async value => {
    const root = await repo({ 'docs/.features/a.json': value });
    expect(await inspectMigrations(root)).toEqual([expect.objectContaining({ status: 'invalid' })]);
    await expect(applyMigrations(root)).rejects.toMatchObject({ code: 'migration-blocked' });
  });
  it('distinguishes malformed JSON and incompatible legacy shapes', async () => {
    const root = await repo({ 'docs/.features/a.json': {} });
    await expect(applyMigrations(root)).rejects.toMatchObject({ code: 'migration-v0-shape-invalid' });
    await fs.writeFile(path.join(root, 'docs/.features/a.json'), '{');
    expect(await inspectMigrations(root)).toEqual([expect.objectContaining({ status: 'invalid' })]);
  });
  it('upgrades and validates every supported artifact kind, and returns no receipt when current', async () => {
    const root = await repo({
      'docs/.features/a.json': { ...feature('a'), schemaVersion: 0 },
      'docs/.plans/a.json': { id: 'a', featureId: 'a', title: 'A', summary: 'A', recordedBy: 'owner', recordedAt: date },
      'docs/.changes/a.json': { id: 'a', kind: 'fix', summary: 'A', featureIds: ['a'], base: 'HEAD', files: [{ status: 'added', file: 'a.ts' }], recordedBy: 'owner', recordedAt: date },
      [LEGACY_MIGRATION_FILE]: { createdBy: 'owner', createdAt: date, evidenceGraphSha256: 'a'.repeat(64), policy: 'no-human-document-moves-without-approval', documents: [] },
      [GOVERNANCE_EXCEPTIONS_FILE]: { exceptions: [] },
    });
    const inspected = await inspectMigrations(root);
    expect(inspected).toHaveLength(5);
    // The configured manifest paths are separate from generated Markdown.
    const receipt = await applyMigrations(root);
    expect(receipt?.changes.length).toBe(inspected.length);
    expect((await inspectMigrations(root)).every(item => item.status === 'current')).toBe(true);
    await expect(applyMigrations(root)).resolves.toBeUndefined();
  });
  it.each([false, true])('recovers publication failure (restore fails: %s)', async restoreFails => {
    const root = await repo({ 'docs/.features/a.json': feature('a'), 'docs/.features/b.json': feature('b') });
    const before = await fs.readFile(path.join(root, 'docs/.features/a.json'), 'utf8');
    const rename = fs.rename.bind(fs);
    let failed = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (String(target) === path.join(root, 'docs/.features/b.json')) { failed = true; throw new Error('publish blocked'); }
      if (failed && restoreFails && String(target) === path.join(root, 'docs/.features/a.json')) throw new Error('restore blocked');
      return rename(source, target);
    });
    await expect(applyMigrations(root)).rejects.toMatchObject({ code: 'migration-apply-failed', message: expect.stringContaining(restoreFails ? 'restore failed' : 'rolled back') });
    const contents = await fs.readFile(path.join(root, 'docs/.features/a.json'), 'utf8');
    expect(contents === before).toBe(!restoreFails);
    if (restoreFails) expect(await fs.readdir(path.join(root, MIGRATIONS_DIR))).toHaveLength(1);
  });
  it.each([false, true])('recovers receipt publication failure (restore fails: %s)', async restoreFails => {
    const root = await repo({ 'docs/.features/a.json': feature('a') });
    const before = await fs.readFile(path.join(root, 'docs/.features/a.json'), 'utf8');
    const link = fs.link.bind(fs), rename = fs.rename.bind(fs);
    let receiptFailed = false;
    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      if (String(target).endsWith('receipt.json')) { receiptFailed = true; throw new Error('receipt blocked'); }
      return link(source, target);
    });
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (receiptFailed && restoreFails) throw new Error('restore blocked');
      return rename(source, target);
    });
    await expect(applyMigrations(root)).rejects.toMatchObject({ code: 'migration-receipt-failed', message: expect.stringContaining(restoreFails ? 'restore failed' : 'were restored') });
    expect((await fs.readFile(path.join(root, 'docs/.features/a.json'), 'utf8')) === before).toBe(!restoreFails);
  });
  it('rejects absent receipts, corrupted backups, and repeated rollback', async () => {
    const root = await repo({ 'docs/.features/a.json': feature('a') });
    await expect(rollbackMigration(root, 'missing')).rejects.toMatchObject({ code: 'migration-receipt-invalid' });
    const receipt = (await applyMigrations(root))!;
    const backup = path.join(root, receipt.changes[0]!.backupFile);
    const original = await fs.readFile(backup, 'utf8');
    await fs.writeFile(backup, 'corrupt');
    await expect(rollbackMigration(root, receipt.id)).rejects.toMatchObject({ code: 'migration-backup-corrupt' });
    await fs.writeFile(backup, original);
    await rollbackMigration(root, receipt.id);
    await expect(rollbackMigration(root, receipt.id)).rejects.toMatchObject({ code: 'migration-already-rolled-back' });
  });
  it.each(['artifact', 'receipt'])('restores migrated bytes after rollback %s failure', async failure => {
    const root = await repo({ 'docs/.features/a.json': feature('a'), 'docs/.features/b.json': feature('b') });
    const receipt = (await applyMigrations(root))!;
    const file = path.join(root, 'docs/.features/a.json');
    const migrated = await fs.readFile(file, 'utf8');
    const rename = fs.rename.bind(fs);
    let failed = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      const matched = failure === 'receipt' ? String(target).endsWith('receipt.json') : String(target) === path.join(root, 'docs/.features/b.json');
      if (!failed && matched) { failed = true; throw new Error('rollback blocked'); }
      return rename(source, target);
    });
    await expect(rollbackMigration(root, receipt.id)).rejects.toMatchObject({ code: failure === 'receipt' ? 'migration-rollback-receipt-failed' : 'migration-rollback-failed' });
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(migrated);
  });
  it.each(['apply', 'receipt', 'rollback', 'rollback-receipt'] as const)('retains audit failure when %s recovery cleanup fails', async phase => {
    const root = await repo({ 'docs/.features/a.json': feature('a'), 'docs/.features/b.json': feature('b') });
    const receipt = phase.startsWith('rollback') ? (await applyMigrations(root))! : undefined;
    const link = fs.link.bind(fs), rename = fs.rename.bind(fs);
    let published = false;
    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      if (phase === 'receipt' && String(target).endsWith('receipt.json')) { published = true; throw new Error('receipt failure'); }
      return link(source, target);
    });
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      const failing = phase.endsWith('receipt') ? String(target).endsWith('receipt.json') : String(target).endsWith(`${path.sep}b.json`);
      if (phase !== 'receipt' && ((!published && failing) || (phase.startsWith('rollback') && published))) { published = true; throw new Error('publication failure'); }
      return rename(source, target);
    });
    const remove = fs.rm.bind(fs);
    vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      if (path.basename(String(file)).startsWith('migration-')) throw new Error('cleanup failure');
      return remove(file, options);
    });
    const operation = receipt === undefined ? applyMigrations(root) : rollbackMigration(root, receipt.id);
    await expect(operation).rejects.toMatchObject({ code: `migration-${phase === 'apply' ? 'apply' : phase}-failed` });
  });
});
