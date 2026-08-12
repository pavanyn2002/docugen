import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';
import { DocgenError, describeUnknownError } from '../util/errors.js';
import { compareStrings } from '../util/sort.js';
import { writeFileAtomically } from '../util/atomic.js';
import { toPosix } from '../util/paths.js';

export const FILE_FINGERPRINT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_FILE_FINGERPRINT_INDEX = '.docgen/cache/file-fingerprints.json';

export interface FileFingerprint {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface FileFingerprintManifest {
  readonly schemaVersion: typeof FILE_FINGERPRINT_SCHEMA_VERSION;
  readonly files: readonly FileFingerprint[];
}

export interface FileFingerprintDiff {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly deleted: readonly string[];
  readonly unchanged: readonly string[];
}

const fingerprintSchema = z
  .object({
    file: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const manifestSchema = z
  .object({
    schemaVersion: z.literal(FILE_FINGERPRINT_SCHEMA_VERSION),
    files: z.array(fingerprintSchema).readonly(),
  })
  .strict();

/** Hash every source file in the configured scan boundary in stable path order. */
export async function fingerprintFiles(options: {
  readonly root: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  /** Human governance records excluded from source parsing but still change-sensitive. */
  readonly additionalInclude?: readonly string[];
}): Promise<FileFingerprintManifest> {
  const [sourceFiles, additionalFiles] = await Promise.all([
    fg([...options.include], {
      cwd: options.root,
      ignore: [...options.exclude],
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
    }),
    options.additionalInclude === undefined || options.additionalInclude.length === 0
      ? Promise.resolve([])
      : fg([...options.additionalInclude], {
          cwd: options.root,
          ignore: ['**/.git/**', '**/.docgen/cache/**'],
          onlyFiles: true,
          dot: true,
          followSymbolicLinks: false,
        }),
  ]);
  const files = [...new Set([...sourceFiles, ...additionalFiles].map(toPosix))]
    .sort(compareStrings);

  const fingerprints: FileFingerprint[] = [];
  for (const file of files) {
    try {
      const contents = await fs.readFile(path.join(options.root, file));
      fingerprints.push({
        file,
        bytes: contents.byteLength,
        sha256: createHash('sha256').update(contents).digest('hex'),
      });
    } catch {
      // A file can disappear between globbing and reading. It will appear as
      // deleted (or be discovered as added) on the next stable index run.
    }
  }
  return { schemaVersion: FILE_FINGERPRINT_SCHEMA_VERSION, files: fingerprints };
}

export function diffFileFingerprints(
  previous: FileFingerprintManifest | undefined,
  current: FileFingerprintManifest,
): FileFingerprintDiff {
  const before = new Map((previous?.files ?? []).map((entry) => [entry.file, entry]));
  const after = new Map(current.files.map((entry) => [entry.file, entry]));
  const added: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  const unchanged: string[] = [];

  for (const entry of current.files) {
    const old = before.get(entry.file);
    if (old === undefined) added.push(entry.file);
    else if (old.sha256 !== entry.sha256 || old.bytes !== entry.bytes) changed.push(entry.file);
    else unchanged.push(entry.file);
  }
  for (const entry of previous?.files ?? []) {
    if (!after.has(entry.file)) deleted.push(entry.file);
  }
  return { added, changed, deleted, unchanged };
}

export function serialiseFileFingerprints(manifest: FileFingerprintManifest): string {
  const canonical = {
    ...manifest,
    files: [...manifest.files].sort((a, b) => compareStrings(a.file, b.file)),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function parseFileFingerprints(contents: string, file = 'file fingerprint index'): FileFingerprintManifest {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (cause) {
    throw new DocgenError({
      code: 'fingerprint-index-unparseable',
      message: `${file} is not valid JSON: ${describeUnknownError(cause)}`,
      remedy: 'Delete the rebuildable fingerprint index and run indexing again.',
      file,
      cause,
    });
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new DocgenError({
      code: 'fingerprint-index-schema-invalid',
      message: `${file} does not match file fingerprint schema v${FILE_FINGERPRINT_SCHEMA_VERSION}.`,
      remedy: 'Delete the rebuildable fingerprint index and run indexing again.',
      file,
    });
  }
  const manifest = parsed.data as FileFingerprintManifest;
  const sorted = [...manifest.files].sort((a, b) => compareStrings(a.file, b.file));
  if (new Set(sorted.map((entry) => entry.file)).size !== sorted.length) {
    throw new DocgenError({
      code: 'fingerprint-index-duplicate-file',
      message: `${file} contains duplicate file entries.`,
      remedy: 'Delete the rebuildable fingerprint index and run indexing again.',
      file,
    });
  }
  return { ...manifest, files: sorted };
}

export async function readFileFingerprints(file: string): Promise<FileFingerprintManifest | undefined> {
  try {
    return parseFileFingerprints(await fs.readFile(file, 'utf8'), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Write canonical bytes through a sibling temporary file, then replace atomically. */
export async function writeFileFingerprints(
  file: string,
  manifest: FileFingerprintManifest,
): Promise<{ readonly file: string; readonly bytes: number; readonly sha256: string }> {
  const contents = serialiseFileFingerprints(manifest);
  const absolute = path.resolve(file);
  try {
    await writeFileAtomically(absolute, contents);
  } catch (cause) {
    throw new DocgenError({
      code: 'fingerprint-index-write-failed',
      message: `Could not write file fingerprint index: ${absolute}.`,
      remedy: 'Check directory permissions and that no process has locked the index, then retry.',
      file: absolute,
      cause,
    });
  }
  return {
    file: absolute,
    bytes: Buffer.byteLength(contents),
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}
