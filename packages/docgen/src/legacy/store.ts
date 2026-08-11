import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LEGACY_MIGRATION_FILE } from '../config/paths.js';
import { DocgenError } from '../util/errors.js';
import { describeUnknownError } from '../util/errors.js';
import { compareStrings } from '../util/sort.js';
import { legacyMigrationManifestSchema } from './schema.js';
import type { LegacyMigrationManifest } from './schema.js';

export function serialiseLegacyMigrationManifest(manifest: LegacyMigrationManifest): string {
  const canonical: LegacyMigrationManifest = {
    ...manifest,
    documents: [...manifest.documents]
      .sort((a, b) => compareStrings(a.path, b.path))
      .map((document) => ({
        ...document,
        replacementPaths: [...document.replacementPaths].sort(compareStrings),
        classificationHistory: [...document.classificationHistory],
      })),
  };
  return `${JSON.stringify(legacyMigrationManifestSchema.parse(canonical), null, 2)}\n`;
}

export async function loadLegacyMigrationManifest(root: string): Promise<LegacyMigrationManifest> {
  const absolute = path.join(root, LEGACY_MIGRATION_FILE);
  let json: unknown;
  try {
    json = JSON.parse(await fs.readFile(absolute, 'utf8'));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DocgenError({
        code: 'legacy-migration-missing',
        message: `Legacy migration manifest does not exist at ${LEGACY_MIGRATION_FILE}.`,
        remedy: 'Create it with `docgen legacy inventory --write` before recording decisions.',
        file: LEGACY_MIGRATION_FILE,
        cause,
      });
    }
    throw new DocgenError({
      code: 'legacy-migration-unparseable',
      message: `${LEGACY_MIGRATION_FILE} is not valid JSON: ${describeUnknownError(cause)}`,
      remedy: 'Repair the human-owned manifest; Docgen will not replace it automatically.',
      file: LEGACY_MIGRATION_FILE,
      cause,
    });
  }
  const parsed = legacyMigrationManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new DocgenError({
      code: 'legacy-migration-invalid',
      message: `${LEGACY_MIGRATION_FILE} is invalid: ${parsed.error.issues[0]?.message ?? 'invalid shape'}.`,
      remedy: 'Repair the reported field; migration decisions are never skipped silently.',
      file: LEGACY_MIGRATION_FILE,
    });
  }
  return parsed.data;
}

/** Explicitly update a human-owned manifest through an atomic sibling replacement. */
export async function writeUpdatedLegacyMigrationManifest(
  root: string,
  manifest: LegacyMigrationManifest,
): Promise<string> {
  const absolute = path.join(root, LEGACY_MIGRATION_FILE);
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, serialiseLegacyMigrationManifest(manifest), {
    encoding: 'utf8',
    flag: 'wx',
  });
  try {
    await fs.rename(temporary, absolute);
  } catch (cause) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw new DocgenError({
      code: 'legacy-migration-update-failed',
      message: `Could not atomically update ${LEGACY_MIGRATION_FILE}.`,
      remedy: 'Check file permissions and retry; the prior manifest remains authoritative.',
      file: LEGACY_MIGRATION_FILE,
      cause,
    });
  }
  return LEGACY_MIGRATION_FILE;
}

/** Create once. Review decisions are human-owned and are never overwritten by inventory. */
export async function writeNewLegacyMigrationManifest(
  root: string,
  manifest: LegacyMigrationManifest,
): Promise<string> {
  const relative = LEGACY_MIGRATION_FILE;
  const absolute = path.join(root, relative);
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fs.writeFile(temporary, serialiseLegacyMigrationManifest(manifest), {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fs.link(temporary, absolute);
    await fs.rm(temporary, { force: true });
  } catch (cause) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DocgenError({
        code: 'legacy-migration-already-exists',
        message: `Legacy migration manifest already exists at ${relative}.`,
        remedy: 'Review and edit the existing human-owned decisions; inventory never overwrites them.',
        file: relative,
        cause,
      });
    }
    throw cause;
  }
  return relative;
}
