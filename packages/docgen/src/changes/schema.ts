import { z } from 'zod';

export const CHANGE_RECORD_SCHEMA_VERSION = 1 as const;
export const CHANGE_KINDS = ['feature', 'fix', 'refactor', 'breaking', 'docs'] as const;

const idSchema = z.string().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase kebab-case');
const fileChangeSchema = z
  .object({
    status: z.enum(['added', 'modified', 'deleted', 'renamed']),
    file: z.string().min(1),
    previousFile: z.string().min(1).optional(),
  })
  .strict();

export const changeRecordSchema = z
  .object({
    schemaVersion: z.literal(CHANGE_RECORD_SCHEMA_VERSION),
    id: idSchema,
    kind: z.enum(CHANGE_KINDS),
    summary: z.string().min(1),
    featureIds: z.array(idSchema).min(1).readonly(),
    planIds: z.array(idSchema).readonly().default([]),
    base: z.string().min(1),
    headCommit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    headDate: z.string().datetime({ offset: true }).optional(),
    files: z.array(fileChangeSchema).min(1).readonly(),
    recordedBy: z.string().min(1),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ChangeRecord = z.output<typeof changeRecordSchema>;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export interface StoredChangeRecord extends ChangeRecord {
  readonly sourceFile: string;
}
