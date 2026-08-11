import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fg from 'fast-glob';
import { FEATURES_DIR } from '../config/paths.js';
import { DocgenError, describeUnknownError } from '../util/errors.js';
import { toPosix } from '../util/paths.js';
import { compareStrings } from '../util/sort.js';
import { featureRecordSchema } from './schema.js';
import type { FeatureRecord, StoredFeatureRecord } from './schema.js';

function featureFile(id: string): string {
  return `${FEATURES_DIR}/${id}.json`;
}

export function serialiseFeatureRecord(record: FeatureRecord): string {
  const canonical: FeatureRecord = {
    ...record,
    aliases: [...record.aliases].sort(compareStrings),
    owners: [...record.owners].sort(compareStrings),
    selectors: {
      files: [...record.selectors.files].sort(compareStrings),
      nodes: [...record.selectors.nodes].sort(compareStrings),
    },
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export async function loadFeatureRecords(root: string): Promise<readonly StoredFeatureRecord[]> {
  const files = (await fg(`${FEATURES_DIR}/*.json`, { cwd: root, onlyFiles: true, dot: true }))
    .map(toPosix)
    .sort(compareStrings);
  const records: StoredFeatureRecord[] = [];

  for (const relative of files) {
    let json: unknown;
    try {
      json = JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'));
    } catch (cause) {
      throw new DocgenError({
        code: 'feature-record-unparseable',
        message: `${relative} is not valid JSON: ${describeUnknownError(cause)}`,
        remedy: 'Fix the feature record. Human-owned feature records are never skipped silently.',
        file: relative,
        cause,
      });
    }
    const parsed = featureRecordSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new DocgenError({
        code: 'feature-record-invalid',
        message: `${relative} is not a valid feature record: ${issue?.message ?? 'invalid shape'}.`,
        remedy: 'Fix the reported field or recreate the record with `docgen feature add`.',
        file: relative,
      });
    }
    const expected = featureFile(parsed.data.id);
    if (relative !== expected) {
      throw new DocgenError({
        code: 'feature-record-filename-mismatch',
        message: `${relative} declares feature '${parsed.data.id}', but its canonical path is ${expected}.`,
        remedy: `Rename the file to ${expected}; do not change the stable feature id to fit a filename.`,
        file: relative,
      });
    }
    records.push({ ...parsed.data, sourceFile: relative });
  }

  const names = new Map<string, string>();
  for (const record of records) {
    for (const name of [record.id, ...record.aliases]) {
      const owner = names.get(name);
      if (owner !== undefined && owner !== record.id) {
        throw new DocgenError({
          code: 'feature-name-collision',
          message: `Feature name or alias '${name}' belongs to both '${owner}' and '${record.id}'.`,
          remedy: 'Keep every feature id and rename alias globally unique.',
          file: record.sourceFile,
        });
      }
      names.set(name, record.id);
    }
  }
  return records.sort((a, b) => compareStrings(a.id, b.id));
}

export async function writeNewFeatureRecord(root: string, record: FeatureRecord): Promise<string> {
  const parsed = featureRecordSchema.parse(record);
  // Load first so an alias cannot silently steal another feature's identity.
  const existing = await loadFeatureRecords(root);
  const requestedNames = new Set([parsed.id, ...parsed.aliases]);
  const collision = existing.find((candidate) =>
    [candidate.id, ...candidate.aliases].some((name) => requestedNames.has(name)),
  );
  if (collision !== undefined) {
    throw new DocgenError({
      code: 'feature-already-exists',
      message: `Feature '${parsed.id}' conflicts with existing feature '${collision.id}'.`,
      remedy: 'Use the existing stable id, or choose an id and aliases that are not already registered.',
      file: collision.sourceFile,
    });
  }

  const relative = featureFile(parsed.id);
  const absolute = path.join(root, relative);
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fs.writeFile(temporary, serialiseFeatureRecord(parsed), { encoding: 'utf8', flag: 'wx' });
    // A hard link publishes fully-written bytes atomically and refuses to
    // replace an existing human-owned record on every supported platform.
    await fs.link(temporary, absolute);
    await fs.rm(temporary, { force: true });
  } catch (cause) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DocgenError({
        code: 'feature-already-exists',
        message: `Feature record already exists at ${relative}.`,
        remedy: 'Edit the human-owned record deliberately instead of replacing it implicitly.',
        file: relative,
        cause,
      });
    }
    throw cause;
  }
  return relative;
}
