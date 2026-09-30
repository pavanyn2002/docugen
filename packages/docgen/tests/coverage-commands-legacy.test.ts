import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLegacyInventoryCommand, runLegacyClassifyCommand, runLegacyPlanCommand, runLegacyApproveCommand, runLegacyArchiveCommand } from '../src/commands/legacy.js';
import { loadLegacyMigrationManifest } from '../src/legacy/store.js';
import { legacyArchiveTarget } from '../src/legacy/plans.js';
import { LEGACY_MIGRATION_FILE } from '../src/config/paths.js';
import type { Logger } from '../src/util/logger.js';
import { createRepository } from './helpers/repository.js';

let root: string;
const messages: string[] = [];
const outputs: string[] = [];
const logger: Logger = { level: 'debug', error: (s) => messages.push(s), warn: (s) => messages.push(s), info: (s) => messages.push(s), debug: (s) => messages.push(s), heading: (s) => messages.push(s), output: (s) => outputs.push(s) };
const options = () => ({ cwd: root, logger });
async function write(file: string, contents: string) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), contents); }
async function inventory(extra: Record<string, unknown> = {}) { await runLegacyInventoryCommand({ ...options(), write: true, recordedBy: 'reviewer', recordedAt: '2026-09-30T00:00:00Z', ...extra }); }
async function classify(classification = 'orphaned', extra: Record<string, unknown> = {}) { await runLegacyClassifyCommand({ ...options(), document: 'docs/old.md', classification, reason: 'Reviewed source evidence', ...extra }); }
async function approve(extra: Record<string, unknown> = {}) { await runLegacyApproveCommand({ ...options(), document: 'docs/old.md', reason: 'Reviewed archive', ...extra }); }
async function preparedArchive() { await inventory(); await classify(); await approve(); }
beforeEach(async () => {
  root = await createRepository();
  await write('docs/old.md', '# Old behavior\n\nSee `app/page.tsx`.\n');
  await write('docs/other.md', '# Other behavior\n\nUndocumented use cases.\n');
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); messages.length = 0; outputs.length = 0; await fs.rm(root, { recursive: true, force: true }); });

describe('legacy review classifications', () => {
  it('renders a read-only inventory and emits classification, approval, plans, and archive JSON', async () => {
    await runLegacyInventoryCommand(options());
    expect(messages.join('\n')).toContain('read-only; pass --write');
    await inventory();
    await classify('orphaned', { json: true, configFile: 'docgen.config.json' });
    expect(JSON.parse(outputs.pop()!).classification).toBe('orphaned');
    await runLegacyPlanCommand({ ...options(), configFile: 'docgen.config.json', json: true });
    expect(JSON.parse(outputs.pop()!).archives).toBe(1);
    await approve({ json: true, configFile: 'docgen.config.json' });
    expect(JSON.parse(outputs.pop()!).approval).toBe('approved');
    await runLegacyArchiveCommand({ ...options(), configFile: 'docgen.config.json', document: 'docs/old.md', actor: 'maintainer', actedAt: '2026-09-30T02:00:00Z', json: true });
    expect(JSON.parse(outputs.pop()!)).toMatchObject({ executedBy: 'maintainer', recoverable: true });
  });

  it('inventories duplicate documents and records attribution outside Git', async () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'missing-config'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    await fs.rm(path.join(root, '.git'), { recursive: true });
    await write('docs/duplicate.md', '# Old behavior\n\nSee `app/page.tsx`.\n');
    await runLegacyInventoryCommand({ ...options(), write: true, configFile: 'docgen.config.json' });
    const manifest = await loadLegacyMigrationManifest(root);
    expect(manifest.createdBy).toBe('unknown');
    expect(manifest.sourceCommit).toBeUndefined();
    expect(manifest.documents.some((item) => item.classification === 'duplicate')).toBe(true);
    expect(messages.join('\n')).toContain('manifest');
    await runLegacyInventoryCommand({ ...options(), json: true });
    expect(JSON.parse(outputs.pop()!).wroteManifest).toBe(false);
  });

  it.each([
    ['current', 'retain'], ['partial', 'replace'], ['contradicted', 'replace'], ['orphaned', 'archive'], ['unverifiable', 'review'],
  ])('maps reviewed classification %s to action %s', async (classification, action) => {
    await inventory();
    await classify(classification, { decidedBy: 'maintainer', decidedAt: '2026-09-30T01:00:00Z', replacements: ' docs/generated/new.md,docs/generated/new.md ' });
    const document = (await loadLegacyMigrationManifest(root)).documents.find((item) => item.path === 'docs/old.md')!;
    expect(document.proposedAction).toBe(action);
    expect(document.replacementPaths).toEqual(['docs/generated/new.md']);
    expect(document.classificationHistory.at(-1)?.decidedBy).toBe('maintainer');
    expect(messages.join('\n')).toContain('Legacy document classified');
  });

  it('records explicit actions and an unknown author when no Git identity exists', async () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'missing-config')); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    await fs.rm(path.join(root, '.git'), { recursive: true });
    await inventory();
    await classify('current', { action: 'archive' });
    await approve();
    await runLegacyArchiveCommand({ ...options(), document: 'docs/old.md' });
    const document = (await loadLegacyMigrationManifest(root)).documents.find((item) => item.path === 'docs/old.md')!;
    expect(document.classificationHistory.at(-1)?.decidedBy).toBe('unknown');
    expect(document.approval.approvedBy).toBe('unknown');
    expect(document.execution?.executedBy).toBe('unknown');
    expect(messages.join('\n')).toContain('Legacy document archived');
  });

  it.each([
    { classification: 'duplicate', code: 'legacy-classification-invalid' },
    { action: 'delete', code: 'legacy-action-invalid' },
    { reason: ' ', code: 'legacy-classification-reason-required' },
    { document: '../old.md', code: 'legacy-document-path-invalid' },
    { document: '..', code: 'legacy-document-path-invalid' },
    { document: '/old.md', code: 'legacy-document-path-invalid' },
    { document: 'C:/old.md', code: 'legacy-document-path-invalid' },
    { document: 'missing.md', code: 'legacy-document-not-in-manifest' },
  ])('rejects invalid review $code', async ({ code, ...extra }) => {
    await inventory();
    await expect(runLegacyClassifyCommand({ ...options(), document: 'docs/old.md', classification: 'current', reason: 'Reviewed', ...extra })).rejects.toMatchObject({ code });
  });

  it.each(['deleted', 'changed', 'graph'] as const)('refuses classification when %s evidence becomes stale', async (mutation) => {
    await inventory();
    if (mutation === 'deleted') await fs.rm(path.join(root, 'docs/old.md'));
    if (mutation === 'changed') await write('docs/old.md', 'Changed prose');
    if (mutation === 'graph') await write('app/page.tsx', 'export default function Renamed() { return null; }');
    await expect(classify()).rejects.toMatchObject({ code: mutation === 'graph' ? 'legacy-evidence-stale' : 'legacy-document-changed' });
  });
});

describe('legacy approval and archive safeguards', () => {
  it('requires an approval reason and an actionable human review', async () => {
    await expect(runLegacyApproveCommand({ ...options(), document: 'docs/old.md', reason: ' ' })).rejects.toMatchObject({ code: 'legacy-approval-reason-required' });
    await inventory();
    await expect(approve()).rejects.toMatchObject({ code: 'legacy-action-not-approvable' });
    await classify('unverifiable');
    await expect(approve()).rejects.toMatchObject({ code: 'legacy-action-not-approvable' });
    await expect(runLegacyArchiveCommand({ ...options(), document: 'docs/old.md' })).rejects.toMatchObject({ code: 'legacy-archive-not-approved' });
  });

  it.each(['missing', 'deleted', 'changed', 'graph'] as const)('refuses approval after %s context changes', async (mutation) => {
    await inventory(); await classify();
    if (mutation === 'deleted') await fs.rm(path.join(root, 'docs/old.md'));
    if (mutation === 'changed') await write('docs/old.md', 'Changed prose');
    if (mutation === 'graph') await write('app/page.tsx', 'export default function Changed() { return null; }');
    await expect(approve(mutation === 'missing' ? { document: 'missing.md' } : {})).rejects.toMatchObject({ code: mutation === 'missing' ? 'legacy-document-not-in-manifest' : mutation === 'graph' ? 'legacy-evidence-stale' : 'legacy-document-changed' });
  });

  it('requires complete replacements and refuses archival after a replacement disappears', async () => {
    await inventory();
    await classify('partial', { replacements: 'docs/generated/new.md' });
    await expect(approve()).rejects.toMatchObject({ code: 'legacy-replacement-not-ready' });
    await write('docs/generated/new.md', '# Replacement');
    await runLegacyPlanCommand(options());
    await approve({ actor: 'maintainer', actedAt: '2026-09-30T01:00:00Z' });
    await fs.rm(path.join(root, 'docs/generated/new.md'));
    await expect(runLegacyArchiveCommand({ ...options(), document: 'docs/old.md' })).rejects.toMatchObject({ code: 'legacy-archive-not-ready' });
  });

  it('preserves archives when the selected reviewed action is retain', async () => {
    await inventory(); await classify('current'); await approve();
    await expect(runLegacyArchiveCommand({ ...options(), document: 'docs/old.md' })).rejects.toMatchObject({ code: 'legacy-archive-not-approved' });
  });

  it('never overwrites existing archived prose', async () => {
    await preparedArchive();
    const target = legacyArchiveTarget('docs/old.md');
    await write(target, 'Previous archived prose');
    await expect(runLegacyArchiveCommand({ ...options(), document: 'docs/old.md' })).rejects.toMatchObject({ code: 'legacy-archive-target-exists' });
    expect(await fs.readFile(path.join(root, target), 'utf8')).toBe('Previous archived prose');
  });

  it('rejects a directory junction introduced after inventory', async () => {
    await preparedArchive();
    const originalDocs = path.join(root, 'docs');
    const relocatedDocs = path.join(root, 'relocated-docs');
    await fs.rename(originalDocs, relocatedDocs);
    await fs.symlink(relocatedDocs, originalDocs, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(runLegacyArchiveCommand({ ...options(), document: 'docs/old.md' })).rejects.toMatchObject({ code: 'legacy-archive-symlink-rejected' });
    await fs.unlink(originalDocs);
    await fs.rename(relocatedDocs, originalDocs);
  });

  it('rejects a source replaced by a directory after its archive plan was checked', async () => {
    await preparedArchive();
    const nativeLstat = fs.lstat;
    const source = path.join(root, 'docs/old.md');
    let replaced = false;
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (!replaced && String(args[0]) === source) {
        replaced = true;
        await fs.rm(source);
        await fs.mkdir(source);
      }
      return nativeLstat(...args);
    });
    await expect(runLegacyArchiveCommand({ ...options(), document: 'docs/old.md' })).rejects.toMatchObject({ code: 'legacy-archive-source-not-file' });
    expect((await fs.stat(source)).isDirectory()).toBe(true);
  });

  it('propagates access-denied errors while checking an existing archive destination', async () => {
    await preparedArchive();
    const nativeLstat = fs.lstat;
    const target = path.join(root, legacyArchiveTarget('docs/old.md'));
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === target) throw Object.assign(new Error('Archive access denied'), { code: 'EACCES' });
      return nativeLstat(...args);
    });
    await expect(runLegacyArchiveCommand({ ...options(), document: 'docs/old.md' })).rejects.toThrow('Archive access denied');
    expect(await fs.readFile(path.join(root, 'docs/old.md'), 'utf8')).toContain('Old behavior');
  });

  it.each([false, true])('preserves recoverability when manifest publication fails (rollback also fails: %s)', async (rollbackFails) => {
    await preparedArchive();
    const nativeRename = fs.rename;
    const target = path.join(root, legacyArchiveTarget('docs/old.md'));
    const source = path.join(root, 'docs/old.md');
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === path.join(root, LEGACY_MIGRATION_FILE)) throw Object.assign(new Error('Publication denied'), { code: 'EACCES' });
      if (rollbackFails && String(from) === target && String(to) === source) throw Object.assign(new Error('Rollback denied'), { code: 'EACCES' });
      return nativeRename(from, to);
    });
    await expect(runLegacyArchiveCommand({ ...options(), document: 'docs/old.md' })).rejects.toMatchObject({ code: rollbackFails ? 'legacy-archive-rollback-failed' : 'legacy-migration-update-failed' });
    expect(await fs.readFile(rollbackFails ? target : source, 'utf8')).toContain('Old behavior');
    expect((await loadLegacyMigrationManifest(root)).documents.find((item) => item.path === 'docs/old.md')?.execution).toBeUndefined();
  });
});
