import { z } from 'zod';

export const FEATURE_RECORD_SCHEMA_VERSION = 1 as const;
export const FEATURE_STATUSES = ['planned', 'active', 'deprecated', 'retired'] as const;
export const FEATURE_CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;

const featureIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case id');

const selectorPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(value), {
    message: 'must be a repository-relative glob',
  });

export const featureRecordSchema = z
  .object({
    schemaVersion: z.literal(FEATURE_RECORD_SCHEMA_VERSION),
    id: featureIdSchema,
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    aliases: z.array(featureIdSchema).readonly().default([]),
    status: z.enum(FEATURE_STATUSES).default('active'),
    owners: z.array(z.string().min(1)).readonly().default([]),
    criticality: z.enum(FEATURE_CRITICALITIES).default('medium'),
    selectors: z
      .object({
        files: z.array(selectorPathSchema).readonly().default([]),
        nodes: z.array(z.string().min(1)).readonly().default([]),
      })
      .strict()
      .default({}),
    recordedBy: z.string().min(1),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.aliases.includes(record.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['aliases'], message: 'cannot contain the feature id' });
    }
    if (new Set(record.aliases).size !== record.aliases.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['aliases'], message: 'must not contain duplicates' });
    }
  });

export type FeatureRecord = z.output<typeof featureRecordSchema>;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];
export type FeatureCriticality = (typeof FEATURE_CRITICALITIES)[number];

export interface StoredFeatureRecord extends FeatureRecord {
  /** Repository-relative record path, used as human provenance. */
  readonly sourceFile: string;
}
