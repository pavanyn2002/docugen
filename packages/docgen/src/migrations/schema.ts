import { z } from 'zod';

export const MIGRATION_RECEIPT_SCHEMA_VERSION = 1 as const;

export const migrationChangeSchema = z.object({
  file: z.string().min(1),
  kind: z.enum(['feature', 'plan', 'change', 'legacy', 'governance']),
  fromVersion: z.literal(0),
  toVersion: z.literal(1),
  beforeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  afterSha256: z.string().regex(/^[a-f0-9]{64}$/),
  backupFile: z.string().min(1),
}).strict();

export const migrationReceiptSchema = z.object({
  schemaVersion: z.literal(MIGRATION_RECEIPT_SCHEMA_VERSION),
  id: z.string().regex(/^migration-[0-9]{8}t[0-9]{6}z-[a-f0-9]{8}$/),
  appliedAt: z.string().datetime({ offset: true }),
  changes: z.array(migrationChangeSchema).min(1).readonly(),
  rolledBackAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export type MigrationChange = z.output<typeof migrationChangeSchema>;
export type MigrationReceipt = z.output<typeof migrationReceiptSchema>;
