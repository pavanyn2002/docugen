import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { REQUIREMENTS_DIR } from '../config/paths.js';
import { DocgenError, describeUnknownError } from '../util/errors.js';
import { toPosix } from '../util/paths.js';
import { compareStrings } from '../util/sort.js';
import { KIND_PREFIXES, REQUIREMENT_KINDS, REQUIREMENT_STATUSES } from './types.js';
import type { Requirement, RequirementKind, RequirementStatus, SurfaceRequirements } from './types.js';
import { assertUniqueHumanValues, humanRecordSlugSchema, parseHumanRecord } from '../util/human-records.js';
import { assertGeneratedPath } from '../util/generated.js';
import { writeFileAtomically } from '../util/atomic.js';
import { requirementIdSchema, reserveRequirementId } from './ids.js';

const requirementSchema = z.object({
  id: requirementIdSchema,
  questionId: z.string().min(1),
  statement: z.string().min(1),
  kind: z.enum(REQUIREMENT_KINDS).default('context'),
  status: z.enum(REQUIREMENT_STATUSES).default('confirmed'),
  title: z.string().optional(),
  surfaceId: z.string().min(1).optional(),
  recordedBy: z.string().default('unknown'),
  recordedAt: z.string().default(''),
  note: z.string().optional(),
}).strict();

const surfaceRequirementsSchema = z.object({
  surfaceId: z.string().min(1),
  slug: humanRecordSlugSchema.optional(),
  requirements: z.array(requirementSchema).default([]),
}).strict().refine(record => record.requirements.every(requirement => requirement.surfaceId === undefined || requirement.surfaceId === record.surfaceId), 'requirement surfaceId must match the containing record');

export { REQUIREMENTS_DIR } from '../config/paths.js';

/**
 * Requirements on disk, one file per surface.
 *
 * Per-surface files rather than one numbered list, because the numbered list is
 * a shared counter and a shared counter across forty repositories and a dozen
 * developers is a merge conflict on every triage. Ids are scoped to their
 * surface — `REQ-checkout-01` — which keeps them unique without coordination,
 * stable when another surface changes, and still short enough to quote in a
 * ticket or a test name.
 */

function requirementFile(root: string, slug: string): string {
  return path.join(root, REQUIREMENTS_DIR, `${slug}.yaml`);
}

export async function loadRequirements(root: string): Promise<ReadonlyMap<string, SurfaceRequirements>> {
  const files = (
    await fg([`${REQUIREMENTS_DIR}/*.yaml`, `${REQUIREMENTS_DIR}/*.yml`], { cwd: root, onlyFiles: true })
  )
    .map(toPosix)
    .sort(compareStrings);

  const bySurface = new Map<string, SurfaceRequirements>();
  const ids: string[] = [];

  for (const relative of files) {
    await assertGeneratedPath(root, relative);
    let parsed: unknown;
    try {
      parsed = YAML.parse(await fs.readFile(path.join(root, relative), 'utf8'));
    } catch (cause) {
      // Same reasoning as the answers store: these are decisions a human made,
      // and skipping one docgen cannot read would silently drop a requirement
      // that tests may already be traced to.
      throw new DocgenError({
        code: 'requirements-unparseable',
        message: `${relative} is not valid YAML: ${describeUnknownError(cause)}`,
        remedy:
          'Fix the YAML syntax. These are triaged requirements and are treated as ground truth, ' +
          'so docgen will not skip a file it cannot read.',
        file: relative,
        cause,
      });
    }

    const record = parseHumanRecord(surfaceRequirementsSchema, parsed, relative, 'requirements');
    const slug = record.slug ?? path.posix.basename(relative, path.posix.extname(relative));
    parseHumanRecord(humanRecordSlugSchema, slug, relative, 'requirements');
    const requirements: Requirement[] = record.requirements.map(({ note, ...fields }) => ({ ...fields, title: fields.title ?? fields.questionId, surfaceId: record.surfaceId, ...(note === undefined ? {} : { note }) }));
    ids.push(...requirements.map(requirement => requirement.id));
    assertUniqueHumanValues(ids, relative, 'requirements');
    assertUniqueHumanValues(requirements.map(requirement => requirement.questionId), relative, 'requirements');
    if (bySurface.has(record.surfaceId)) {
      throw new DocgenError({ code: 'requirements-duplicate-surface', message: `${relative} duplicates requirements for '${record.surfaceId}'.`, remedy: 'Merge conflicting human records into one file without discarding requirements.', file: relative });
    }
    bySurface.set(record.surfaceId, {
      surfaceId: record.surfaceId,
      slug,
      sourceFile: relative,
      requirements: requirements.sort((a, b) => compareStrings(a.id, b.id)),
    });
  }

  return bySurface;
}

/**
 * Allocate the next id for a kind within a surface.
 *
 * This helper only sees its input. Persistent allocation also supplies immutable
 * reservations, so deleting a record cannot release a previously issued ID.
 */
export function nextRequirementId(
  /** Only the ids matter here, so that is all this asks for. */
  existing: readonly { readonly id: string }[],
  kind: RequirementKind,
  slug: string,
): string {
  const prefix = `${KIND_PREFIXES[kind]}-${slug}-`;
  const highest = existing
    .filter((requirement) => requirement.id.startsWith(prefix))
    .map((requirement) => Number.parseInt(requirement.id.slice(prefix.length), 10))
    .filter((value) => Number.isInteger(value))
    .reduce((max, value) => Math.max(max, value), 0);

  return `${prefix}${String(highest + 1).padStart(2, '0')}`;
}

export interface RecordRequirementArgs {
  readonly root: string;
  readonly surfaceId: string;
  readonly slug: string;
  readonly kind: RequirementKind;
  readonly title: string;
  readonly statement: string;
  readonly questionId: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly note?: string;
  readonly status?: RequirementStatus;
}

/**
 * Record a triage decision.
 *
 * Re-triaging the same question replaces the entry in place, keeping its id, so
 * a reclassification does not orphan anything that referenced it.
 */
export async function recordRequirement(args: RecordRequirementArgs): Promise<Requirement> {
  const relative = `${REQUIREMENTS_DIR}/${args.slug}.yaml`;
  const { root, slug, ...fields } = args;
  parseHumanRecord(surfaceRequirementsSchema, { surfaceId: args.surfaceId, slug, requirements: [{ ...fields, id: 'REQ-validation-01' }] }, relative, 'requirements');
  const all = await loadRequirements(args.root);
  const existing = all.get(args.surfaceId);
  const previous = existing?.requirements.find(
    (requirement) => requirement.questionId === args.questionId,
  );

  const id = await reserveRequirementId({
    root,
    surfaces: [...all.values()],
    surfaceId: args.surfaceId,
    slug: existing?.slug ?? slug,
    kind: args.kind,
    ...(previous !== undefined && previous.kind === args.kind ? { existingId: previous.id } : {}),
  });
  const requirement: Requirement = {
    id,
    kind: args.kind,
    status: args.status ?? 'confirmed',
    title: args.title,
    statement: args.statement,
    questionId: args.questionId,
    surfaceId: args.surfaceId,
    recordedBy: args.recordedBy,
    recordedAt: args.recordedAt,
    ...(args.note === undefined ? {} : { note: args.note }),
  };

  const kept = (existing?.requirements ?? []).filter(
    (candidate) => candidate.questionId !== args.questionId,
  );

  const merged: SurfaceRequirements = {
    surfaceId: args.surfaceId,
    slug: existing?.slug ?? slug,
    requirements: [...kept, requirement].sort((a, b) => compareStrings(a.id, b.id)),
  };

  const file = existing?.sourceFile === undefined ? requirementFile(root, slug) : path.join(root, existing.sourceFile);
  await assertGeneratedPath(root, toPosix(path.relative(root, file)));
  await writeFileAtomically(file, renderRequirementsFile(merged));

  return requirement;
}

/** YAML with a header, since a developer may well edit this by hand. */
export function renderRequirementsFile(surface: SurfaceRequirements): string {
  const header = [
    '# Triaged requirements, recorded by docgen.',
    '#',
    '# Each entry is a developer decision about an answered question: whether the',
    '# behaviour is intended, a defect, a deliberate technical decision, or context.',
    '# Ids are stable and are never reused — a test or a ticket may quote one.',
    '',
  ].join('\n');

  return `${header}${YAML.stringify(
    {
      surfaceId: surface.surfaceId,
      slug: surface.slug,
      requirements: surface.requirements.map((requirement) => ({
        id: requirement.id,
        kind: requirement.kind,
        status: requirement.status,
        title: requirement.title,
        statement: requirement.statement,
        questionId: requirement.questionId,
        recordedBy: requirement.recordedBy,
        recordedAt: requirement.recordedAt,
        ...(requirement.note === undefined ? {} : { note: requirement.note }),
      })),
    },
    { lineWidth: 100 },
  )}`;
}
