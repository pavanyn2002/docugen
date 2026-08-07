import fs from 'node:fs/promises';
import path from 'node:path';
import { DocgenError, describeUnknownError } from '../../util/errors.js';

/** A router technology found in the target repo, with the directory it lives in. */
export interface RouterDetection {
  readonly kind: 'next-app' | 'next-pages' | 'react-router';
  /** Repo-relative POSIX directory, e.g. 'src/app'. Absent for react-router. */
  readonly dir?: string;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function hasAnyEntry(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

/**
 * Read the repo's package.json dependency names.
 *
 * A missing package.json is absent input and yields an empty set. A corrupt one
 * is malformed input and is reported loudly (SPEC rule 6) — proceeding would
 * mean silently failing to detect the framework and emitting empty docs that
 * look like a clean result.
 */
export async function readDependencyNames(root: string): Promise<ReadonlySet<string>> {
  const manifest = path.join(root, 'package.json');
  let raw: string;
  try {
    raw = await fs.readFile(manifest, 'utf8');
  } catch {
    return new Set();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new DocgenError({
      code: 'package-json-unparseable',
      message: `package.json is not valid JSON: ${describeUnknownError(cause)}`,
      remedy: 'Fix the JSON syntax. docgen cannot detect the framework without it.',
      file: manifest,
      cause,
    });
  }

  if (parsed === null || typeof parsed !== 'object') return new Set();

  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const section = (parsed as Record<string, unknown>)[field];
    if (section !== null && typeof section === 'object') {
      for (const name of Object.keys(section)) names.add(name);
    }
  }
  return names;
}

/**
 * Detect which routers the repo uses.
 *
 * Detection requires both the dependency and a populated conventional
 * directory. A repo can legitimately have both Next routers at once, so this
 * returns every match rather than picking one.
 */
export async function detectRouters(root: string): Promise<readonly RouterDetection[]> {
  const deps = await readDependencyNames(root);
  const found: RouterDetection[] = [];

  if (deps.has('next')) {
    for (const dir of ['app', 'src/app']) {
      const absolute = path.join(root, dir);
      if ((await isDirectory(absolute)) && (await hasAnyEntry(absolute))) {
        found.push({ kind: 'next-app', dir });
      }
    }
    for (const dir of ['pages', 'src/pages']) {
      const absolute = path.join(root, dir);
      if ((await isDirectory(absolute)) && (await hasAnyEntry(absolute))) {
        found.push({ kind: 'next-pages', dir });
      }
    }
  }

  if (deps.has('react-router') || deps.has('react-router-dom')) {
    found.push({ kind: 'react-router' });
  }

  return found;
}
