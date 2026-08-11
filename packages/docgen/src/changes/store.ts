import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { CHANGES_DIR } from '../config/paths.js';
import { DocgenError, describeUnknownError } from '../util/errors.js';
import { toPosix } from '../util/paths.js';
import { compareStrings } from '../util/sort.js';
import { changeRecordSchema } from './schema.js';
import type { ChangeRecord, StoredChangeRecord } from './schema.js';

function changeFile(id: string): string {
  return `${CHANGES_DIR}/${id}.json`;
}

export function serialiseChangeRecord(record: ChangeRecord): string {
  const canonical: ChangeRecord = {
    ...record,
    featureIds: [...record.featureIds].sort(compareStrings),
    planIds: [...record.planIds].sort(compareStrings),
    files: [...record.files].sort((a, b) => compareStrings(a.file, b.file)),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export async function loadChangeRecords(root: string): Promise<readonly StoredChangeRecord[]> {
  const files = (await fg(`${CHANGES_DIR}/*.json`, { cwd: root, onlyFiles: true, dot: true }))
    .map(toPosix)
    .sort(compareStrings);
  const records: StoredChangeRecord[] = [];
  for (const relative of files) {
    let json: unknown;
    try {
      json = JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'));
    } catch (cause) {
      throw new DocgenError({
        code: 'change-record-unparseable',
        message: `${relative} is not valid JSON: ${describeUnknownError(cause)}`,
        remedy: 'Fix the attributed change record; it will never be skipped silently.',
        file: relative,
        cause,
      });
    }
    const parsed = changeRecordSchema.safeParse(json);
    if (!parsed.success) {
      throw new DocgenError({
        code: 'change-record-invalid',
        message: `${relative} is not a valid change record: ${parsed.error.issues[0]?.message ?? 'invalid shape'}.`,
        remedy: 'Fix the record or recreate it with `docgen change record`.',
        file: relative,
      });
    }
    const expected = changeFile(parsed.data.id);
    if (relative !== expected) {
      throw new DocgenError({
        code: 'change-record-filename-mismatch',
        message: `${relative} declares change '${parsed.data.id}', but its canonical path is ${expected}.`,
        remedy: `Rename the file to ${expected}; keep the stable change id unchanged.`,
        file: relative,
      });
    }
    records.push({ ...parsed.data, sourceFile: relative });
  }
  return records.sort((a, b) => compareStrings(a.id, b.id));
}

export async function writeNewChangeRecord(root: string, record: ChangeRecord): Promise<string> {
  const parsed = changeRecordSchema.parse(record);
  if ((await loadChangeRecords(root)).some((candidate) => candidate.id === parsed.id)) {
    throw new DocgenError({
      code: 'change-already-exists',
      message: `Change '${parsed.id}' already exists.`,
      remedy: 'Use the existing immutable record or choose a new stable change id.',
      file: changeFile(parsed.id),
    });
  }
  const relative = changeFile(parsed.id);
  const absolute = path.join(root, relative);
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fs.writeFile(temporary, serialiseChangeRecord(parsed), { encoding: 'utf8', flag: 'wx' });
    await fs.link(temporary, absolute);
    await fs.rm(temporary, { force: true });
    return relative;
  } catch (cause) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DocgenError({
        code: 'change-already-exists',
        message: `Change record already exists at ${relative}.`,
        remedy: 'Change records are immutable; choose a new id for a new change.',
        file: relative,
        cause,
      });
    }
    throw cause;
  }
}
