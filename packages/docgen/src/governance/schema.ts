import { z } from 'zod';

export const GOVERNANCE_EXCEPTION_SCHEMA_VERSION = 1 as const;
export const GOVERNANCE_POLICY_IDS = [
  'changed-feature-plan',
  'tester-handoff',
  'critical-feature-verification',
  'requirement-test-coverage',
] as const;
export type GovernancePolicyId = (typeof GOVERNANCE_POLICY_IDS)[number];

export const governanceExceptionSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase kebab-case'),
  policy: z.enum(GOVERNANCE_POLICY_IDS),
  subject: z.string().min(1).optional(),
  owner: z.string().min(1),
  reason: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  recordedAt: z.string().datetime({ offset: true }),
}).strict();

export const governanceExceptionsSchema = z.object({
  schemaVersion: z.literal(GOVERNANCE_EXCEPTION_SCHEMA_VERSION),
  exceptions: z.array(governanceExceptionSchema).readonly().default([]),
}).strict().superRefine((record, context) => {
  const ids = record.exceptions.map((item) => item.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['exceptions'], message: 'exception ids must be unique' });
});

export type GovernanceException = z.output<typeof governanceExceptionSchema>;
export type GovernanceExceptions = z.output<typeof governanceExceptionsSchema>;
