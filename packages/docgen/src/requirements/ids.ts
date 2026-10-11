import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';
import { REQUIREMENTS_DIR } from '../config/paths.js';
import { writeFileAtomically } from '../util/atomic.js';
import { assertGeneratedPath } from '../util/generated.js';
import { DocgenError } from '../util/errors.js';
import { compareStrings } from '../util/sort.js';
import { KIND_PREFIXES } from './types.js';
import type { RequirementKind, SurfaceRequirements } from './types.js';

const ID_DIRECTORY = `${REQUIREMENTS_DIR}/.ids`;
export const requirementIdSchema = z.string().regex(/^(REQ|BUG|ADR|CTX)-[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/, 'must be a scoped requirement identifier');
const reservationSchema = z.object({ schemaVersion: z.literal(1), id: requirementIdSchema, surfaceId: z.string().min(1) }).strict();
type Reservation = z.infer<typeof reservationSchema>;

async function readReservation(root: string, relative: string): Promise<Reservation> {
  await assertGeneratedPath(root, relative);
  try {
    const record = reservationSchema.parse(JSON.parse(await fs.readFile(path.join(root, relative), 'utf8')));
    if (path.posix.basename(relative, '.json') !== record.id) throw new Error('reservation filename must match its id');
    return record;
  } catch (cause) {
    throw new DocgenError({ code: 'requirement-id-reservation-invalid', message: `Cannot read requirement ID reservation ${relative}.`, remedy: 'Restore the reservation from Git; deleting it can allow an existing identifier to be reused.', file: relative, cause });
  }
}

async function readReservations(root: string): Promise<Map<string, Reservation>> {
  await assertGeneratedPath(root, ID_DIRECTORY);
  const files = await fg(`${ID_DIRECTORY}/*.json`, { cwd: root, onlyFiles: true, dot: true });
  const records = new Map<string, Reservation>();
  for (const relative of files.sort(compareStrings)) {
    const record = await readReservation(root, relative);
    records.set(record.id, record);
  }
  return records;
}

/** Immutable reservations survive edits or deletion of the owning YAML file. */
async function tryReserve(root: string, record: Reservation): Promise<boolean> {
  const relative = `${ID_DIRECTORY}/${record.id}.json`;
  await assertGeneratedPath(root, relative);
  try {
    await writeFileAtomically(path.join(root, relative), `${JSON.stringify(record, null, 2)}\n`, { createOnly: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Validate even a concurrently created record before trusting the collision.
    await readReservation(root, relative);
    return false;
  }
}

/** Seed old records before replacing them, then reserve the next unused number. */
export async function reserveRequirementId(args: {
  root: string;
  surfaces: readonly SurfaceRequirements[];
  surfaceId: string;
  slug: string;
  kind: RequirementKind;
  existingId?: string;
}): Promise<string> {
  const reservations = await readReservations(args.root);
  for (const surface of args.surfaces) {
    for (const requirement of surface.requirements) {
      const record: Reservation = { schemaVersion: 1, id: requirement.id, surfaceId: surface.surfaceId };
      let existing = reservations.get(record.id);
      if (existing === undefined) {
        if (await tryReserve(args.root, record)) existing = record;
        else existing = await readReservation(args.root, `${ID_DIRECTORY}/${record.id}.json`);
        reservations.set(record.id, existing);
      }
      if (existing.surfaceId !== surface.surfaceId) {
        throw new DocgenError({ code: 'requirement-id-owner-mismatch', message: `${record.id} is reserved for another surface.`, remedy: 'Restore the original surface identity or explicitly assign a new requirement ID.', file: `${ID_DIRECTORY}/${record.id}.json` });
      }
    }
  }
  if (args.existingId !== undefined) return args.existingId;

  const prefix = `${KIND_PREFIXES[args.kind]}-${args.slug}-`;
  let highest = 0;
  for (const id of reservations.keys()) {
    const suffix = id.startsWith(prefix) ? id.slice(prefix.length) : '';
    if (/^\d+$/.test(suffix)) highest = Math.max(highest, Number(suffix));
  }
  // Create-only publication prevents competing processes from allocating the same ID.
  for (;;) {
    highest += 1;
    if (!Number.isSafeInteger(highest)) throw new DocgenError({ code: 'requirement-id-exhausted', message: `Requirement numbering is exhausted for ${prefix}.`, remedy: 'Review the stored identifier reservations.' });
    const id = `${prefix}${String(highest).padStart(2, '0')}`;
    if (await tryReserve(args.root, { schemaVersion: 1, id, surfaceId: args.surfaceId })) return id;
  }
}
