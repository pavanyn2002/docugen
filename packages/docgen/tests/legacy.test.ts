import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runLegacyApproveCommand,
  runLegacyArchiveCommand,
  runLegacyClassifyCommand,
  runLegacyInventoryCommand,
  runLegacyPlanCommand,
} from '../src/commands/legacy.js';
import {
  LEGACY_ARCHIVE_PLAN_FILE,
  LEGACY_MIGRATION_FILE,
  LEGACY_REPLACEMENT_PLAN_FILE,
} from '../src/config/paths.js';
import { inventoryLegacyDocuments } from '../src/legacy/inventory.js';
import { legacyMigrationManifestSchema } from '../src/legacy/schema.js';
import { createLogger } from '../src/util/logger.js';

const created: string[] = [];

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-legacy-'));
  created.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, contents, 'utf8');
  }
  return root;
}

function captureLogger() {
  const stdout: string[] = [];
  const sink = { write: (chunk: string) => (stdout.push(chunk), true) } as unknown as NodeJS.WritableStream;
  return { stdout, logger: createLogger({ level: 'info', stdout: sink, stderr: sink }) };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('legacy documentation inventory', () => {
  it('treats prose as unreviewed, resolves local references, and identifies only exact duplicates', async () => {
    const duplicate = '# Old setup\nRun the old command.\n';
    const root = await makeRepo({
      'README.md': '# App\nSee [source](src/app.ts) and [removed](docs/missing.md).\n',
      'docs/a-old.md': duplicate,
      'docs/b-copy.md': duplicate,
      'docs/generated/system.md': '# Managed\n',
      'src/app.ts': 'export const app = true;\n',
    });

    const inventory = await inventoryLegacyDocuments({ root, outDir: 'docs/generated' });
    expect(inventory.counts).toMatchObject({
      total: 4,
      humanAuthored: 3,
      docgenGenerated: 1,
      unreviewed: 2,
      duplicates: 1,
    });
    expect(inventory.documents.find((document) => document.path === 'README.md')).toMatchObject({
      ownership: 'human-authored',
      classification: 'unreviewed',
      references: [
        { target: 'docs/missing.md', exists: false },
        { target: 'src/app.ts', exists: true },
      ],
    });
    expect(inventory.documents.find((document) => document.path === 'docs/b-copy.md')).toMatchObject({
      classification: 'duplicate',
      duplicateOf: 'docs/a-old.md',
    });
    expect(inventory.documents.find((document) => document.path === 'docs/generated/system.md')).toMatchObject({
      ownership: 'docgen-generated',
    });
  });

  it('maps only explicit file links and exact inline-code identifiers to graph entities', async () => {
    const root = await makeRepo({
      'README.md': [
        '# Runbook',
        'See the [implementation](src/app.ts).',
        'Call `run` to start it.',
        'Customers always receive an immediate response.',
      ].join('\n'),
      'src/app.ts': 'export function run() { return true; }\n',
    });
    const output = captureLogger();
    await runLegacyInventoryCommand({ cwd: root, json: true, logger: output.logger });

    const document = JSON.parse(output.stdout.join('')).documents.find(
      (candidate: { path: string }) => candidate.path === 'README.md',
    );
    expect(document).toMatchObject({
      classification: 'unreviewed',
      evidenceStatus: 'partial',
      references: [
        { target: 'src/app.ts', exists: true, graphNodeIds: ['file:src/app.ts'] },
      ],
    });
    expect(document.claims.find((claim: { excerpt: string }) => claim.excerpt.includes('implementation')))
      .toMatchObject({ mapping: 'mapped', matchedBy: ['local-reference'] });
    expect(document.claims.find((claim: { excerpt: string }) => claim.excerpt.includes('Call')))
      .toMatchObject({
        mapping: 'mapped',
        matchedBy: ['inline-code'],
        graphNodeIds: ['symbol:src/app.ts#function:run'],
      });
    expect(document.claims.find((claim: { excerpt: string }) => claim.excerpt.includes('Customers')))
      .toMatchObject({ mapping: 'unmapped', graphNodeIds: [] });
  });

  it('is read-only by default and creates a non-overwriting approval manifest on request', async () => {
    const root = await makeRepo({ 'README.md': '# Legacy\n' });
    const before = await fs.readFile(path.join(root, 'README.md'), 'utf8');
    await runLegacyInventoryCommand({ cwd: root, json: true, logger: captureLogger().logger });
    await expect(fs.stat(path.join(root, LEGACY_MIGRATION_FILE))).rejects.toThrow();
    await expect(fs.readFile(path.join(root, 'README.md'), 'utf8')).resolves.toBe(before);

    const output = captureLogger();
    await runLegacyInventoryCommand({
      cwd: root,
      write: true,
      json: true,
      logger: output.logger,
      recordedBy: 'owner@example.com',
      recordedAt: '2026-08-11T12:00:00.000Z',
    });
    expect(JSON.parse(output.stdout.join(''))).toMatchObject({
      wroteManifest: true,
      manifestFile: LEGACY_MIGRATION_FILE,
      mutatedLegacyDocuments: 0,
    });
    const manifest = legacyMigrationManifestSchema.parse(
      JSON.parse(await fs.readFile(path.join(root, LEGACY_MIGRATION_FILE), 'utf8')),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      createdBy: 'owner@example.com',
      policy: 'no-human-document-moves-without-approval',
      documents: [
        {
          path: 'README.md',
          classification: 'unreviewed',
          proposedAction: 'review',
          approval: { required: true, status: 'pending' },
        },
      ],
    });
    await expect(
      runLegacyInventoryCommand({
        cwd: root,
        write: true,
        logger: captureLogger().logger,
        recordedBy: 'owner@example.com',
        recordedAt: '2026-08-11T12:00:00.000Z',
      }),
    ).rejects.toThrow(/already exists/);
    await expect(fs.readFile(path.join(root, 'README.md'), 'utf8')).resolves.toBe(before);
  });

  it('records an attributed classification without changing the legacy document', async () => {
    const root = await makeRepo({
      'README.md': '# Legacy API\nUse `run` for the old workflow.\n',
      'src/app.ts': 'export function run() { return true; }\n',
    });
    await runLegacyInventoryCommand({
      cwd: root,
      write: true,
      logger: captureLogger().logger,
      recordedBy: 'inventory@example.com',
      recordedAt: '2026-08-11T10:00:00.000Z',
    });
    const before = await fs.readFile(path.join(root, 'README.md'), 'utf8');
    const output = captureLogger();
    await runLegacyClassifyCommand({
      cwd: root,
      document: 'README.md',
      classification: 'partial',
      reason: 'The entry point exists, but the workflow description needs replacement.',
      replacements: 'docs/generated/features/api.md',
      json: true,
      logger: output.logger,
      decidedBy: 'reviewer@example.com',
      decidedAt: '2026-08-11T11:00:00.000Z',
    });

    expect(JSON.parse(output.stdout.join(''))).toMatchObject({
      document: 'README.md',
      classification: 'partial',
      proposedAction: 'replace',
      approval: 'pending',
      mutatedLegacyDocuments: 0,
    });
    const manifest = legacyMigrationManifestSchema.parse(
      JSON.parse(await fs.readFile(path.join(root, LEGACY_MIGRATION_FILE), 'utf8')),
    );
    expect(manifest.documents[0]).toMatchObject({
      classification: 'partial',
      proposedAction: 'replace',
      replacementPaths: ['docs/generated/features/api.md'],
      approval: { required: true, status: 'pending' },
      classificationHistory: [
        {
          from: 'unreviewed',
          to: 'partial',
          decidedBy: 'reviewer@example.com',
          decidedAt: '2026-08-11T11:00:00.000Z',
        },
      ],
    });
    await expect(fs.readFile(path.join(root, 'README.md'), 'utf8')).resolves.toBe(before);
  });

  it('rejects classification when document bytes or graph evidence became stale', async () => {
    const root = await makeRepo({
      'README.md': '# Legacy\nSee `run`.\n',
      'src/app.ts': 'export function run() {}\n',
    });
    await runLegacyInventoryCommand({
      cwd: root,
      write: true,
      logger: captureLogger().logger,
      recordedBy: 'inventory@example.com',
      recordedAt: '2026-08-11T10:00:00.000Z',
    });
    await fs.writeFile(path.join(root, 'README.md'), '# Changed legacy\n', 'utf8');
    await expect(
      runLegacyClassifyCommand({
        cwd: root,
        document: 'README.md',
        classification: 'current',
        reason: 'Reviewed.',
        logger: captureLogger().logger,
      }),
    ).rejects.toThrow(/changed after it was inventoried/);

    await fs.writeFile(path.join(root, 'README.md'), '# Legacy\nSee `run`.\n', 'utf8');
    await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export function renamed() {}\n', 'utf8');
    await expect(
      runLegacyClassifyCommand({
        cwd: root,
        document: 'README.md',
        classification: 'contradicted',
        reason: 'The old symbol was removed.',
        logger: captureLogger().logger,
      }),
    ).rejects.toThrow(/evidence graph changed/);
  });

  it('generates operation plans and archives only after explicit approval', async () => {
    const oldContents = '# Old API\nUse `removedHandler`.\n';
    const root = await makeRepo({
      'docs/old-api.md': oldContents,
      'src/app.ts': 'export function currentHandler() {}\n',
    });
    await runLegacyInventoryCommand({
      cwd: root,
      write: true,
      logger: captureLogger().logger,
      recordedBy: 'inventory@example.com',
      recordedAt: '2026-08-11T09:00:00.000Z',
    });
    await runLegacyClassifyCommand({
      cwd: root,
      document: 'docs/old-api.md',
      classification: 'contradicted',
      reason: 'The documented handler is absent from the current graph.',
      replacements: 'docs/generated/features/api.md',
      logger: captureLogger().logger,
      decidedBy: 'reviewer@example.com',
      decidedAt: '2026-08-11T10:00:00.000Z',
    });

    await expect(
      runLegacyApproveCommand({
        cwd: root,
        document: 'docs/old-api.md',
        reason: 'Replacement reviewed.',
        logger: captureLogger().logger,
      }),
    ).rejects.toThrow(/missing or incomplete/);
    await expect(
      runLegacyArchiveCommand({
        cwd: root,
        document: 'docs/old-api.md',
        logger: captureLogger().logger,
      }),
    ).rejects.toThrow(/does not have approval/);

    await fs.mkdir(path.join(root, 'docs', 'generated', 'features'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'docs', 'generated', 'features', 'api.md'),
      '# Current API\n',
      'utf8',
    );
    const planned = captureLogger();
    await runLegacyPlanCommand({ cwd: root, json: true, logger: planned.logger });
    expect(JSON.parse(planned.stdout.join(''))).toMatchObject({
      replacementFile: LEGACY_REPLACEMENT_PLAN_FILE,
      archiveFile: LEGACY_ARCHIVE_PLAN_FILE,
      replacements: 1,
      archives: 1,
      readyForApproval: 1,
      readyForExecution: 0,
      mutatedLegacyDocuments: 0,
    });

    await runLegacyApproveCommand({
      cwd: root,
      document: 'docs/old-api.md',
      reason: 'The generated replacement exists and was reviewed.',
      logger: captureLogger().logger,
      actor: 'approver@example.com',
      actedAt: '2026-08-11T11:00:00.000Z',
    });
    await runLegacyPlanCommand({ cwd: root, logger: captureLogger().logger });
    const archivePlan = JSON.parse(await fs.readFile(path.join(root, LEGACY_ARCHIVE_PLAN_FILE), 'utf8'));
    expect(archivePlan.documents[0]).toMatchObject({
      path: 'docs/old-api.md',
      replacementsReady: true,
      readyForExecution: true,
    });

    await runLegacyArchiveCommand({
      cwd: root,
      document: 'docs/old-api.md',
      logger: captureLogger().logger,
      actor: 'operator@example.com',
      actedAt: '2026-08-11T12:00:00.000Z',
    });
    await expect(fs.stat(path.join(root, 'docs', 'old-api.md'))).rejects.toThrow();
    await expect(
      fs.readFile(path.join(root, 'docs', 'legacy-archive', 'docs', 'old-api.md'), 'utf8'),
    ).resolves.toBe(oldContents);
    const manifest = legacyMigrationManifestSchema.parse(
      JSON.parse(await fs.readFile(path.join(root, LEGACY_MIGRATION_FILE), 'utf8')),
    );
    expect(manifest.documents[0]).toMatchObject({
      approval: { status: 'approved', approvedBy: 'approver@example.com' },
      approvalHistory: [{ from: 'pending', to: 'approved', decidedBy: 'approver@example.com' }],
      execution: {
        status: 'archived',
        source: 'docs/old-api.md',
        target: 'docs/legacy-archive/docs/old-api.md',
        executedBy: 'operator@example.com',
      },
    });
    const inventory = await inventoryLegacyDocuments({ root, outDir: 'docs/generated' });
    expect(inventory.counts.archivedHuman).toBe(1);
    expect(inventory.counts.humanAuthored).toBe(0);
  });
});
