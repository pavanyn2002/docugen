import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import {
  CHANGES_DIR,
  FEATURES_DIR,
  GOVERNANCE_EXCEPTIONS_FILE,
  LEGACY_MIGRATION_FILE,
  MIGRATIONS_DIR,
  PLANS_DIR,
} from '../config/paths.js';
import { changeRecordSchema } from '../changes/schema.js';
import { featureRecordSchema } from '../features/schema.js';
import { governanceExceptionsSchema } from '../governance/schema.js';
import { legacyMigrationManifestSchema } from '../legacy/schema.js';
import { planRecordSchema } from '../plans/schema.js';
import { writeFileAtomically } from '../util/atomic.js';
import { DocgenError, describeUnknownError } from '../util/errors.js';
import { toPosix } from '../util/paths.js';
import { compareStrings } from '../util/sort.js';
import {
  MIGRATION_RECEIPT_SCHEMA_VERSION,
  migrationReceiptSchema,
} from './schema.js';
import type { MigrationChange, MigrationReceipt } from './schema.js';

export type MigrationArtifactKind = MigrationChange['kind'];
export type MigrationStatus = 'current' | 'pending' | 'unsupported' | 'invalid';

export interface MigrationInspection {
  readonly file: string;
  readonly kind: MigrationArtifactKind;
  readonly status: MigrationStatus;
  readonly version?: number;
  readonly message: string;
}

interface ArtifactDefinition {
  readonly kind: MigrationArtifactKind;
  readonly glob: string;
  readonly validate: (value: unknown) => boolean;
}

const DEFINITIONS: readonly ArtifactDefinition[] = [
  { kind: 'feature', glob: `${FEATURES_DIR}/*.json`, validate: (value) => featureRecordSchema.safeParse(value).success },
  { kind: 'plan', glob: `${PLANS_DIR}/*.json`, validate: (value) => planRecordSchema.safeParse(value).success },
  { kind: 'change', glob: `${CHANGES_DIR}/*.json`, validate: (value) => changeRecordSchema.safeParse(value).success },
  { kind: 'legacy', glob: LEGACY_MIGRATION_FILE, validate: (value) => legacyMigrationManifestSchema.safeParse(value).success },
  { kind: 'governance', glob: GOVERNANCE_EXCEPTIONS_FILE, validate: (value) => governanceExceptionsSchema.safeParse(value).success },
];

export async function inspectMigrations(root: string): Promise<readonly MigrationInspection[]> {
  const inspections: MigrationInspection[] = [];
  for (const definition of DEFINITIONS) {
    const files = await fg(definition.glob, { cwd: root, onlyFiles: true, dot: true });
    for (const file of files.map(toPosix).sort(compareStrings)) {
      inspections.push(await inspectFile(root, file, definition));
    }
  }
  return inspections.sort((a, b) => compareStrings(a.file, b.file));
}

export async function applyMigrations(
  root: string,
  options: { readonly now?: Date } = {},
): Promise<MigrationReceipt | undefined> {
  const inspections = await inspectMigrations(root);
  const blocking = inspections.find((item) => item.status === 'invalid' || item.status === 'unsupported');
  if (blocking !== undefined) {
    throw new DocgenError({
      code: 'migration-blocked',
      message: `Cannot migrate ${blocking.file}: ${blocking.message}`,
      remedy: 'Repair the invalid artifact or upgrade Docgen to a version that supports its schema.',
      file: blocking.file,
    });
  }
  const pending = inspections.filter((item) => item.status === 'pending');
  if (pending.length === 0) return undefined;

  const now = options.now ?? new Date();
  const id = migrationId(now);
  const migrationRoot = path.join(root, MIGRATIONS_DIR, id);
  const backupRoot = `${MIGRATIONS_DIR}/${id}/before`;
  const prepared: Array<{ inspection: MigrationInspection; before: string; after: string; backupFile: string }> = [];
  for (const inspection of pending) {
    const before = await fs.readFile(path.join(root, inspection.file), 'utf8');
    const parsed = JSON.parse(before) as Record<string, unknown>;
    const afterValue = { ...parsed, schemaVersion: 1 };
    const definition = DEFINITIONS.find((item) => item.kind === inspection.kind) as ArtifactDefinition;
    if (!definition.validate(afterValue)) {
      throw new DocgenError({
        code: 'migration-v0-shape-invalid',
        message: `${inspection.file} has no schemaVersion but is not compatible with the v1 ${inspection.kind} schema.`,
        remedy: 'Repair the artifact explicitly; Docgen will not invent missing human-governed fields.',
        file: inspection.file,
      });
    }
    prepared.push({
      inspection,
      before,
      after: `${JSON.stringify(afterValue, null, 2)}\n`,
      backupFile: `${backupRoot}/${inspection.file}`,
    });
  }

  const published: typeof prepared = [];
  try {
    for (const item of prepared) {
      await writeFileAtomically(path.join(root, item.backupFile), item.before, { createOnly: true });
      await writeFileAtomically(path.join(root, item.inspection.file), item.after);
      published.push(item);
    }
  } catch (cause) {
    let restoredAll = true;
    for (const item of [...published].reverse()) {
      try {
        await writeFileAtomically(path.join(root, item.inspection.file), item.before);
      } catch {
        restoredAll = false;
      }
    }
    if (restoredAll) await fs.rm(migrationRoot, { recursive: true, force: true }).catch(() => undefined);
    throw new DocgenError({
      code: 'migration-apply-failed',
      message: restoredAll
        ? 'The migration could not be published; already changed artifacts were rolled back.'
        : 'The migration could not be published and at least one automatic restore failed.',
      remedy: restoredAll
        ? 'Check repository permissions and retry `docgen migrate`.'
        : `Preserve ${MIGRATIONS_DIR}/${id}; use its before/ backups to restore the listed artifacts, then retry.`,
      cause,
    });
  }

  const receipt: MigrationReceipt = {
    schemaVersion: MIGRATION_RECEIPT_SCHEMA_VERSION,
    id,
    appliedAt: now.toISOString(),
    changes: prepared.map((item) => ({
      file: item.inspection.file,
      kind: item.inspection.kind,
      fromVersion: 0,
      toVersion: 1,
      beforeSha256: sha256(item.before),
      afterSha256: sha256(item.after),
      backupFile: item.backupFile,
    })),
  };
  try {
    await writeFileAtomically(
      path.join(root, MIGRATIONS_DIR, id, 'receipt.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { createOnly: true },
    );
  } catch (cause) {
    let restoredAll = true;
    for (const item of [...published].reverse()) {
      try {
        await writeFileAtomically(path.join(root, item.inspection.file), item.before);
      } catch {
        restoredAll = false;
      }
    }
    if (restoredAll) await fs.rm(migrationRoot, { recursive: true, force: true }).catch(() => undefined);
    throw new DocgenError({
      code: 'migration-receipt-failed',
      message: restoredAll
        ? 'Migrated artifacts were restored because the audit receipt could not be written.'
        : 'The audit receipt could not be written and at least one automatic restore failed.',
      remedy: restoredAll
        ? 'Check permissions under docs/.migrations and retry.'
        : `Preserve ${MIGRATIONS_DIR}/${id}; use its before/ backups to restore the listed artifacts.`,
      cause,
    });
  }
  return receipt;
}

export async function rollbackMigration(
  root: string,
  id: string,
  options: { readonly now?: Date } = {},
): Promise<MigrationReceipt> {
  const receiptFile = path.join(root, MIGRATIONS_DIR, id, 'receipt.json');
  const receipt = await readReceipt(receiptFile);
  if (receipt.rolledBackAt !== undefined) {
    throw new DocgenError({
      code: 'migration-already-rolled-back',
      message: `Migration '${id}' was already rolled back at ${receipt.rolledBackAt}.`,
      remedy: 'Inspect the existing receipt; no additional rollback is needed.',
      file: toPosix(path.relative(root, receiptFile)),
    });
  }
  const prepared: Array<{ change: MigrationChange; current: string; before: string }> = [];
  for (const change of receipt.changes) {
    const current = await fs.readFile(path.join(root, change.file), 'utf8');
    if (sha256(current) !== change.afterSha256) {
      throw new DocgenError({
        code: 'migration-rollback-conflict',
        message: `${change.file} changed after migration '${id}'.`,
        remedy: 'Preserve the later human edit and resolve the rollback manually.',
        file: change.file,
      });
    }
    const before = await fs.readFile(path.join(root, change.backupFile), 'utf8');
    if (sha256(before) !== change.beforeSha256) {
      throw new DocgenError({
        code: 'migration-backup-corrupt',
        message: `Backup ${change.backupFile} does not match its recorded digest.`,
        remedy: 'Do not roll back from this backup; restore from version control.',
        file: change.backupFile,
      });
    }
    prepared.push({ change, current, before });
  }
  const restored: typeof prepared = [];
  try {
    for (const item of prepared) {
      await writeFileAtomically(path.join(root, item.change.file), item.before);
      restored.push(item);
    }
  } catch (cause) {
    for (const item of [...restored].reverse()) {
      await writeFileAtomically(path.join(root, item.change.file), item.current).catch(() => undefined);
    }
    throw new DocgenError({
      code: 'migration-rollback-failed',
      message: `Migration '${id}' could not be rolled back; restored artifacts were returned to their migrated bytes.`,
      remedy: 'Check file permissions and retry the rollback.',
      cause,
    });
  }
  const updated = migrationReceiptSchema.parse({
    ...receipt,
    rolledBackAt: (options.now ?? new Date()).toISOString(),
  });
  try {
    await writeFileAtomically(receiptFile, `${JSON.stringify(updated, null, 2)}\n`);
  } catch (cause) {
    for (const item of [...restored].reverse()) {
      await writeFileAtomically(path.join(root, item.change.file), item.current).catch(() => undefined);
    }
    throw new DocgenError({
      code: 'migration-rollback-receipt-failed',
      message: `Migration '${id}' remains applied because its rollback receipt could not be published.`,
      remedy: 'Check permissions under docs/.migrations and retry the rollback.',
      file: toPosix(path.relative(root, receiptFile)),
      cause,
    });
  }
  return updated;
}

async function inspectFile(
  root: string,
  file: string,
  definition: ArtifactDefinition,
): Promise<MigrationInspection> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
  } catch (cause) {
    return { file, kind: definition.kind, status: 'invalid', message: describeUnknownError(cause) };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { file, kind: definition.kind, status: 'invalid', message: 'artifact root must be an object' };
  }
  const version = (value as Record<string, unknown>)['schemaVersion'];
  if (version === undefined) {
    return { file, kind: definition.kind, status: 'pending', version: 0, message: 'v0 artifact can be upgraded to v1' };
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return { file, kind: definition.kind, status: 'invalid', message: 'schemaVersion must be a non-negative integer' };
  }
  if (version > 1) {
    return { file, kind: definition.kind, status: 'unsupported', version, message: `schema v${version} is newer than supported v1` };
  }
  if (version < 1) {
    return { file, kind: definition.kind, status: 'pending', version, message: `schema v${version} can be upgraded to v1` };
  }
  return {
    file,
    kind: definition.kind,
    status: definition.validate(value) ? 'current' : 'invalid',
    version,
    message: definition.validate(value) ? 'schema v1 is current' : 'artifact does not match schema v1',
  };
}

async function readReceipt(file: string): Promise<MigrationReceipt> {
  try {
    return migrationReceiptSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (cause) {
    throw new DocgenError({
      code: 'migration-receipt-invalid',
      message: `Migration receipt is missing or invalid: ${file}.`,
      remedy: 'Use a valid migration id from docs/.migrations; do not reconstruct audit receipts by hand.',
      file,
      cause,
    });
  }
}

function migrationId(now: Date): string {
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').toLowerCase();
  return `migration-${timestamp}-${randomBytes(4).toString('hex')}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
