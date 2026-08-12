import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { toPosix } from './paths.js';
import { compareStrings } from './sort.js';

export const ATOMIC_TEMP_MARKER = '.docgen-tmp-';

export interface AtomicWriteOptions {
  /** Refuse to replace an existing target. Intended for immutable human records. */
  readonly createOnly?: boolean;
  /** Testable failure boundary after durable bytes exist but before publication. */
  readonly beforePublish?: (temporary: string) => void | Promise<void>;
}

/**
 * Publish complete sibling bytes in one filesystem operation.
 *
 * A failed write removes its temporary file and never modifies the previous
 * target. Create-only mode uses a hard link so publication also refuses to
 * replace an existing human-owned record on every supported platform.
 */
export async function writeFileAtomically(
  file: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const absolute = path.resolve(file);
  const temporary = `${absolute}${ATOMIC_TEMP_MARKER}${process.pid}-${randomUUID()}`;
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fs.writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
    await options.beforePublish?.(temporary);
    if (options.createOnly === true) {
      await fs.link(temporary, absolute);
      await fs.rm(temporary, { force: true });
    } else {
      await fs.rename(temporary, absolute);
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Temporary files left by a killed process; active writes are younger than the threshold. */
export async function findStaleAtomicFiles(
  root: string,
  options: { readonly olderThanMs?: number; readonly now?: number } = {},
): Promise<readonly string[]> {
  const olderThanMs = options.olderThanMs ?? 60 * 60 * 1000;
  const now = options.now ?? Date.now();
  const candidates = await fg(`**/*${ATOMIC_TEMP_MARKER}*`, {
    cwd: root,
    dot: true,
    onlyFiles: true,
    ignore: ['**/.git/**', '**/node_modules/**'],
  });
  const stale: string[] = [];
  for (const relative of candidates.map(toPosix).sort(compareStrings)) {
    try {
      const stat = await fs.stat(path.join(root, relative));
      if (now - stat.mtimeMs >= olderThanMs) stale.push(relative);
    } catch {
      // It disappeared between discovery and stat, which is already recovered.
    }
  }
  return stale;
}

export async function removeAtomicFiles(root: string, files: readonly string[]): Promise<void> {
  for (const relative of files) {
    const absolute = path.resolve(root, relative);
    const boundary = path.relative(path.resolve(root), absolute);
    if (boundary.startsWith('..') || path.isAbsolute(boundary) || !relative.includes(ATOMIC_TEMP_MARKER)) {
      throw new Error(`Refusing to remove non-Docgen temporary file: ${relative}`);
    }
    await fs.rm(absolute, { force: true });
  }
}
