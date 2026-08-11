import { z } from 'zod';

export const LEGACY_MIGRATION_SCHEMA_VERSION = 1 as const;
export const LEGACY_DOCUMENT_OWNERSHIPS = [
  'human-authored',
  'docgen-generated',
  'docgen-record',
  'archived-human',
] as const;
export const LEGACY_CLASSIFICATIONS = [
  'unreviewed',
  'current',
  'partial',
  'contradicted',
  'duplicate',
  'orphaned',
  'unverifiable',
] as const;
export const LEGACY_MIGRATION_ACTIONS = ['review', 'retain', 'replace', 'archive'] as const;
export const LEGACY_EVIDENCE_STATUSES = [
  'mapped',
  'partial',
  'unmapped',
  'orphaned-references',
] as const;

const relativePath = z
  .string()
  .min(1)
  .refine((value) =>
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !/^[a-zA-Z]:\//.test(value) &&
    !value.split('/').includes('..'), {
    message: 'must be a repository-relative POSIX path',
  });

export const legacyReferenceSchema = z
  .object({
    target: relativePath,
    exists: z.boolean(),
    graphNodeIds: z.array(z.string().min(1)).readonly(),
  })
  .strict();

export const legacyClaimSchema = z
  .object({
    id: z.string().regex(/^legacy-claim:[a-f0-9]{16}$/),
    line: z.number().int().positive(),
    excerpt: z.string().min(1).max(240),
    mapping: z.enum(['mapped', 'ambiguous', 'unmapped']),
    matchedBy: z.array(z.enum(['local-reference', 'inline-code'])).readonly(),
    graphNodeIds: z.array(z.string().min(1)).readonly(),
  })
  .strict();

export const legacyClassificationTransitionSchema = z
  .object({
    from: z.enum(LEGACY_CLASSIFICATIONS),
    to: z.enum(LEGACY_CLASSIFICATIONS),
    decidedBy: z.string().min(1),
    decidedAt: z.string().datetime({ offset: true }),
    reason: z.string().min(1),
    evidenceGraphSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const legacyApprovalTransitionSchema = z
  .object({
    from: z.enum(['pending', 'approved', 'rejected']),
    to: z.enum(['approved', 'rejected']),
    decidedBy: z.string().min(1),
    decidedAt: z.string().datetime({ offset: true }),
    reason: z.string().min(1),
    evidenceGraphSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const legacyArchiveExecutionSchema = z
  .object({
    status: z.literal('archived'),
    source: relativePath,
    target: relativePath,
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    executedBy: z.string().min(1),
    executedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const legacyInventoryDocumentSchema = z
  .object({
    path: relativePath,
    format: z.enum(['markdown', 'mdx', 'restructured-text', 'asciidoc', 'text']),
    ownership: z.enum(LEGACY_DOCUMENT_OWNERSHIPS),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    classification: z.enum(LEGACY_CLASSIFICATIONS),
    rationale: z.string().min(1),
    duplicateOf: relativePath.optional(),
    evidenceStatus: z.enum(LEGACY_EVIDENCE_STATUSES),
    references: z.array(legacyReferenceSchema).readonly(),
    claims: z.array(legacyClaimSchema).readonly(),
  })
  .strict();

export const legacyMigrationDocumentSchema = legacyInventoryDocumentSchema
  .pick({
    path: true,
    sha256: true,
    classification: true,
    rationale: true,
    duplicateOf: true,
    evidenceStatus: true,
    claims: true,
  })
  .extend({
    proposedAction: z.enum(LEGACY_MIGRATION_ACTIONS),
    replacementPaths: z.array(relativePath).readonly(),
    approval: z
      .object({
        required: z.literal(true),
        status: z.enum(['pending', 'approved', 'rejected']),
        approvedBy: z.string().min(1).optional(),
        approvedAt: z.string().datetime({ offset: true }).optional(),
        reason: z.string().min(1).optional(),
      })
      .strict(),
    classificationHistory: z.array(legacyClassificationTransitionSchema).readonly().default([]),
    approvalHistory: z.array(legacyApprovalTransitionSchema).readonly().default([]),
    execution: legacyArchiveExecutionSchema.optional(),
  })
  .strict();

export const legacyMigrationManifestSchema = z
  .object({
    schemaVersion: z.literal(LEGACY_MIGRATION_SCHEMA_VERSION),
    createdBy: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    evidenceGraphSha256: z.string().regex(/^[a-f0-9]{64}$/),
    policy: z.literal('no-human-document-moves-without-approval'),
    documents: z.array(legacyMigrationDocumentSchema).readonly(),
  })
  .strict();

export type LegacyInventoryDocument = z.output<typeof legacyInventoryDocumentSchema>;
export type LegacyMigrationManifest = z.output<typeof legacyMigrationManifestSchema>;
export type LegacyClassification = (typeof LEGACY_CLASSIFICATIONS)[number];
export type LegacyEvidenceStatus = (typeof LEGACY_EVIDENCE_STATUSES)[number];
