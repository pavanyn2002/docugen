import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { REQUIREMENTS_DIR } from '../config/paths.js';
import { DocgenError, describeUnknownError } from '../util/errors.js';
import { toPosix } from '../util/paths.js';
import { compareStrings } from '../util/sort.js';
import { KIND_PREFIXES, REQUIREMENT_KINDS, REQUIREMENT_STATUSES } from './types.js';
import type { Requirement, RequirementKind, RequirementStatus, SurfaceRequirements } from './types.js';

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

  for (const relative of files) {
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

    if (parsed === null || typeof parsed !== 'object') continue;
    const record = parsed as Record<string, unknown>;
    const surfaceId = record['surfaceId'];
    if (typeof surfaceId !== 'string') continue;

    const slug =
      typeof record['slug'] === 'string'
        ? record['slug']
        : path.posix.basename(relative, path.posix.extname(relative));

    const raw = Array.isArray(record['requirements']) ? record['requirements'] : [];
    const requirements: Requirement[] = [];

    for (const entry of raw) {
      const requirement = parseRequirement(entry, surfaceId);
      if (requirement !== undefined) requirements.push(requirement);
    }

    bySurface.set(surfaceId, {
      surfaceId,
      slug,
      requirements: requirements.sort((a, b) => compareStrings(a.id, b.id)),
    });
  }

  return bySurface;
}

function parseRequirement(entry: unknown, surfaceId: string): Requirement | undefined {
  if (entry === null || typeof entry !== 'object') return undefined;
  const value = entry as Record<string, unknown>;

  const id = value['id'];
  const questionId = value['questionId'];
  const statement = value['statement'];
  if (typeof id !== 'string' || typeof questionId !== 'string' || typeof statement !== 'string') {
    return undefined;
  }

  const kind = REQUIREMENT_KINDS.find((candidate) => candidate === value['kind']);
  const status = REQUIREMENT_STATUSES.find((candidate) => candidate === value['status']);

  return {
    id,
    kind: kind ?? 'context',
    status: status ?? 'confirmed',
    title: typeof value['title'] === 'string' ? value['title'] : questionId,
    statement,
    questionId,
    surfaceId: typeof value['surfaceId'] === 'string' ? value['surfaceId'] : surfaceId,
    recordedBy: typeof value['recordedBy'] === 'string' ? value['recordedBy'] : 'unknown',
    recordedAt: typeof value['recordedAt'] === 'string' ? value['recordedAt'] : '',
    ...(typeof value['note'] === 'string' ? { note: value['note'] } : {}),
  };
}

/**
 * Allocate the next id for a kind within a surface.
 *
 * Numbering never reuses a value, even when an entry is removed: an id that has
 * been quoted in a test or a ticket must not later point at something else.
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
  const all = await loadRequirements(args.root);
  const existing = all.get(args.surfaceId);
  const previous = existing?.requirements.find(
    (requirement) => requirement.questionId === args.questionId,
  );

  const requirement: Requirement = {
    id: previous?.id ?? nextRequirementId(existing?.requirements ?? [], args.kind, args.slug),
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

  // A reclassification changes the prefix, so the id would no longer match its
  // kind. Keeping the original id is the lesser evil — it stays resolvable —
  // but only when the kind is unchanged; otherwise a fresh id is issued.
  const resolved =
    previous !== undefined && previous.kind !== args.kind
      ? { ...requirement, id: nextRequirementId(existing?.requirements ?? [], args.kind, args.slug) }
      : requirement;

  const kept = (existing?.requirements ?? []).filter(
    (candidate) => candidate.questionId !== args.questionId,
  );

  const merged: SurfaceRequirements = {
    surfaceId: args.surfaceId,
    slug: args.slug,
    requirements: [...kept, resolved].sort((a, b) => compareStrings(a.id, b.id)),
  };

  const file = requirementFile(args.root, args.slug);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, renderRequirementsFile(merged), 'utf8');

  return resolved;
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
