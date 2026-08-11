import { z } from 'zod';

export const PLAN_RECORD_SCHEMA_VERSION = 1 as const;
export const PLAN_STATUSES = ['draft', 'approved', 'in-progress', 'completed', 'cancelled'] as const;

const idSchema = z.string().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase kebab-case');

export const acceptanceCriterionSchema = z
  .object({
    id: z.string().regex(/^AC-[0-9]{2,}$/, 'must look like AC-01'),
    text: z.string().min(1),
  })
  .strict();

export const planTransitionSchema = z
  .object({
    from: z.enum(PLAN_STATUSES),
    to: z.enum(PLAN_STATUSES),
    changedBy: z.string().min(1),
    changedAt: z.string().datetime({ offset: true }),
    note: z.string().min(1).optional(),
  })
  .strict();

export const planRecordSchema = z
  .object({
    schemaVersion: z.literal(PLAN_RECORD_SCHEMA_VERSION),
    id: idSchema,
    featureId: idSchema,
    title: z.string().min(1),
    summary: z.string().min(1),
    status: z.enum(PLAN_STATUSES).default('draft'),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).readonly().default([]),
    risks: z.array(z.string().min(1)).readonly().default([]),
    testNotes: z.array(z.string().min(1)).readonly().default([]),
    transitions: z.array(planTransitionSchema).readonly().default([]),
    recordedBy: z.string().min(1),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((plan, context) => {
    const ids = plan.acceptanceCriteria.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptanceCriteria'],
        message: 'criterion ids must be unique',
      });
    }
    const finalTransition = plan.transitions.at(-1);
    if (finalTransition !== undefined && finalTransition.to !== plan.status) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transitions'],
        message: 'final transition must end at the current status',
      });
    }
    for (let index = 1; index < plan.transitions.length; index += 1) {
      if (plan.transitions[index - 1]?.to !== plan.transitions[index]?.from) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['transitions', index],
          message: 'transition history must form a continuous chain',
        });
      }
    }
  });

export type PlanRecord = z.output<typeof planRecordSchema>;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface StoredPlanRecord extends PlanRecord {
  readonly sourceFile: string;
}
