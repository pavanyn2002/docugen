import { z } from 'zod';
import { DocgenError } from './errors.js';

/** Reject invalid human data without discarding entries or coercing values. */
export function parseHumanRecord<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, file: string, kind: 'answers' | 'requirements'): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DocgenError({
      code: `${kind}-invalid`,
      message: `${file} contains invalid ${kind}: ${result.error.issues.map(issue => `${issue.path.join('.') || '(root)'} — ${issue.message}`).join('; ')}`,
      remedy: 'Correct the indicated fields. Human-owned records are never silently skipped or repaired.',
      file,
    });
  }
  return result.data;
}

export function assertUniqueHumanValues(values: readonly string[], file: string, kind: 'answers' | 'requirements'): void {
  if (new Set(values).size !== values.length) {
    throw new DocgenError({ code: `${kind}-invalid`, message: `${file} contains duplicate record identifiers.`, remedy: 'Resolve duplicate identifiers explicitly before continuing.', file });
  }
}

/** Slugs become filenames, so use the portable surface-slug vocabulary. */
export const humanRecordSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a filesystem-safe surface slug');
