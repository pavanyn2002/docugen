import path from 'node:path';
import { z } from 'zod';

export const WALKTHROUGH_SCHEMA_VERSION = 1 as const;
export const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024;
const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase kebab-case').max(80);
const heading = z.string().trim().min(1).max(200).refine((text) => !/[\r\n]/.test(text), 'must use one line');
const text = z.string().trim().min(1).max(4000);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export function safeRelativeFile(value: string): boolean {
  return value.length > 0 && value === value.trim() && !/[\u0000-\u001f\u007f\\:?#]/.test(value) &&
    !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) &&
    value.split('/').every((part) => part !== '..' && part !== '' && !/[. ]$/.test(part));
}

export const relativeFileSchema = z.string().refine(safeRelativeFile, 'must be a safe repository-relative file path');
export const publicUrlSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}, 'must be an HTTP(S) URL without embedded credentials').transform((value) => {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.toString();
});

const stepText = z.object({
  title: heading,
  instruction: text,
  alt: heading,
  expected: text.optional(),
  url: publicUrlSchema.optional(),
}).strict();

export const walkthroughInputSchema = z.object({
  schemaVersion: z.literal(WALKTHROUGH_SCHEMA_VERSION).default(WALKTHROUGH_SCHEMA_VERSION),
  id,
  title: heading,
  summary: text.optional(),
  steps: z.array(stepText.extend({ screenshot: relativeFileSchema }).strict()).min(1).max(50),
}).strict();

export const walkthroughRecordSchema = z.object({
  schemaVersion: z.literal(WALKTHROUGH_SCHEMA_VERSION),
  id,
  title: heading,
  summary: text.optional(),
  source: z.enum(['import', 'capture']),
  recordedBy: z.string().trim().min(1),
  recordedAt: z.string().datetime({ offset: true }),
  status: z.enum(['draft', 'reviewed']),
  contentHash: hash,
  steps: z.array(stepText.extend({ screenshot: z.object({
    file: relativeFileSchema,
    sha256: hash,
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    bytes: z.number().int().positive().max(MAX_SCREENSHOT_BYTES),
  }).strict() }).strict()).min(1).max(50),
  review: z.object({
    reviewedBy: z.string().trim().min(1),
    reviewedAt: z.string().datetime({ offset: true }),
    contentHash: hash,
  }).strict().optional(),
}).strict().superRefine((record, context) => {
  if (record.status === 'reviewed' && (record.review === undefined || record.review.contentHash !== record.contentHash)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['review'], message: 'review must identify this exact walkthrough snapshot' });
  }
  if (record.status === 'draft' && record.review !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['review'], message: 'a draft cannot retain a review receipt' });
  }
});

export type WalkthroughInput = z.output<typeof walkthroughInputSchema>;
export type WalkthroughRecord = z.output<typeof walkthroughRecordSchema>;
