import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  LEGACY_ARCHIVE_DIR,
  LEGACY_ARCHIVE_PLAN_FILE,
  LEGACY_REPLACEMENT_PLAN_FILE,
} from '../config/paths.js';
import { compareStrings } from '../util/sort.js';
import type { LegacyMigrationManifest } from './schema.js';
import { serialiseLegacyMigrationManifest } from './store.js';

export const LEGACY_OPERATION_PLAN_SCHEMA_VERSION = 1 as const;

const plannedDocumentBase = z.object({
  path: z.string().min(1),
  classification: z.string().min(1),
  approvalStatus: z.enum(['pending', 'approved', 'rejected']),
});

export const legacyReplacementPlanSchema = z
  .object({
    schemaVersion: z.literal(LEGACY_OPERATION_PLAN_SCHEMA_VERSION),
    kind: z.literal('legacy-replacement-plan'),
    sourceManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceGraphSha256: z.string().regex(/^[a-f0-9]{64}$/),
    plannedAt: z.string().datetime({ offset: true }),
    documents: z.array(
      plannedDocumentBase.extend({
        replacementPaths: z.array(z.string().min(1)).readonly(),
        missingReplacementPaths: z.array(z.string().min(1)).readonly(),
        readyForApproval: z.boolean(),
      }).strict(),
    ).readonly(),
  })
  .strict();

export const legacyArchivePlanSchema = z
  .object({
    schemaVersion: z.literal(LEGACY_OPERATION_PLAN_SCHEMA_VERSION),
    kind: z.literal('legacy-archive-plan'),
    sourceManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceGraphSha256: z.string().regex(/^[a-f0-9]{64}$/),
    plannedAt: z.string().datetime({ offset: true }),
    documents: z.array(
      plannedDocumentBase.extend({
        target: z.string().min(1),
        sourceExists: z.boolean(),
        replacementsReady: z.boolean(),
        readyForExecution: z.boolean(),
        executionStatus: z.enum(['pending', 'archived']),
      }).strict(),
    ).readonly(),
  })
  .strict();

export type LegacyReplacementPlan = z.output<typeof legacyReplacementPlanSchema>;
export type LegacyArchivePlan = z.output<typeof legacyArchivePlanSchema>;

export function legacyArchiveTarget(source: string): string {
  return path.posix.join(LEGACY_ARCHIVE_DIR, source);
}

async function exists(root: string, relative: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(root, relative))).isFile();
  } catch {
    return false;
  }
}

function plannedAt(manifest: LegacyMigrationManifest): string {
  const timestamps = [
    manifest.createdAt,
    ...manifest.documents.flatMap((document) => [
      ...document.classificationHistory.map((transition) => transition.decidedAt),
      ...document.approvalHistory.map((transition) => transition.decidedAt),
      ...(document.execution === undefined ? [] : [document.execution.executedAt]),
    ]),
  ];
  return timestamps.sort(compareStrings).at(-1) as string;
}

/** Derive reviewable operation plans. No source document is mutated. */
export async function buildLegacyOperationPlans(options: {
  readonly root: string;
  readonly manifest: LegacyMigrationManifest;
}): Promise<{ replacement: LegacyReplacementPlan; archive: LegacyArchivePlan }> {
  const sourceManifestSha256 = createHash('sha256')
    .update(serialiseLegacyMigrationManifest(options.manifest))
    .digest('hex');
  const replacements = [];
  const archives = [];
  for (const document of options.manifest.documents) {
    const replacementExistence = await Promise.all(
      document.replacementPaths.map(async (replacement) => ({
        replacement,
        exists: await exists(options.root, replacement),
      })),
    );
    const missingReplacementPaths = replacementExistence
      .filter((item) => !item.exists)
      .map((item) => item.replacement)
      .sort(compareStrings);
    const replacementsReady =
      document.replacementPaths.length > 0 && missingReplacementPaths.length === 0;
    if (document.proposedAction === 'replace') {
      replacements.push({
        path: document.path,
        classification: document.classification,
        approvalStatus: document.approval.status,
        replacementPaths: [...document.replacementPaths].sort(compareStrings),
        missingReplacementPaths,
        readyForApproval: replacementsReady && document.execution === undefined,
      });
    }
    if (document.proposedAction === 'archive' || document.proposedAction === 'replace') {
      const sourceExists = await exists(options.root, document.path);
      archives.push({
        path: document.path,
        classification: document.classification,
        approvalStatus: document.approval.status,
        target: legacyArchiveTarget(document.path),
        sourceExists,
        replacementsReady: document.proposedAction === 'archive' || replacementsReady,
        readyForExecution:
          document.approval.status === 'approved' &&
          sourceExists &&
          document.execution === undefined &&
          (document.proposedAction === 'archive' || replacementsReady),
        executionStatus: document.execution === undefined ? 'pending' : 'archived',
      });
    }
  }
  const common = {
    schemaVersion: LEGACY_OPERATION_PLAN_SCHEMA_VERSION,
    sourceManifestSha256,
    evidenceGraphSha256: options.manifest.evidenceGraphSha256,
    plannedAt: plannedAt(options.manifest),
  } as const;
  return {
    replacement: legacyReplacementPlanSchema.parse({
      ...common,
      kind: 'legacy-replacement-plan',
      documents: replacements.sort((a, b) => compareStrings(a.path, b.path)),
    }),
    archive: legacyArchivePlanSchema.parse({
      ...common,
      kind: 'legacy-archive-plan',
      documents: archives.sort((a, b) => compareStrings(a.path, b.path)),
    }),
  };
}

async function writePlan(root: string, relative: string, contents: string): Promise<void> {
  const absolute = path.join(root, relative);
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.rename(temporary, absolute);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeLegacyOperationPlans(
  root: string,
  plans: { readonly replacement: LegacyReplacementPlan; readonly archive: LegacyArchivePlan },
): Promise<{ readonly replacementFile: string; readonly archiveFile: string }> {
  await Promise.all([
    writePlan(root, LEGACY_REPLACEMENT_PLAN_FILE, `${JSON.stringify(plans.replacement, null, 2)}\n`),
    writePlan(root, LEGACY_ARCHIVE_PLAN_FILE, `${JSON.stringify(plans.archive, null, 2)}\n`),
  ]);
  return {
    replacementFile: LEGACY_REPLACEMENT_PLAN_FILE,
    archiveFile: LEGACY_ARCHIVE_PLAN_FILE,
  };
}
