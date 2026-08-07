import fg from 'fast-glob';
import path from 'node:path';
import type { ExtractorId, SourceRef } from '../types/core.js';
import { DocgenError, describeUnknownError } from '../util/errors.js';
import { toPosix } from '../util/paths.js';
import { TECH_SIGNATURES } from './signatures.js';
import type { TechCategory } from './signatures.js';
import { findWorkspaces, readIfPresent } from './workspaces.js';
import type { Workspace } from './workspaces.js';

export interface DetectedTechnology {
  readonly id: string;
  readonly name: string;
  readonly category: TechCategory;
  /** Workspace directory it was found in. '' for the repo root. */
  readonly workspace: string;
  /** The manifest or file that proves it. */
  readonly evidence: SourceRef;
  /** Extractors that can document it. Empty means docgen sees it but cannot parse it. */
  readonly covers: readonly ExtractorId[];
  readonly unsupportedNote?: string;
}

export interface StackReport {
  readonly workspaces: readonly Workspace[];
  readonly technologies: readonly DetectedTechnology[];
  /** Technologies found that no extractor handles. The honest gap in coverage. */
  readonly unsupported: readonly DetectedTechnology[];
}

/**
 * Extract dependency names from a manifest.
 *
 * Best-effort and format-specific. A manifest docgen cannot read yields no
 * names rather than an error — except package.json, whose corruption would
 * silently disable detection for the whole repo.
 */
export function parseManifestDependencies(fileName: string, contents: string): readonly string[] {
  if (fileName === 'package.json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (cause) {
      throw new DocgenError({
        code: 'package-json-unparseable',
        message: `package.json is not valid JSON: ${describeUnknownError(cause)}`,
        remedy: 'Fix the JSON syntax so docgen can detect the project stack.',
        file: fileName,
        cause,
      });
    }
    if (parsed === null || typeof parsed !== 'object') return [];
    const names: string[] = [];
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      const section = (parsed as Record<string, unknown>)[field];
      if (section !== null && typeof section === 'object') names.push(...Object.keys(section));
    }
    return names;
  }

  if (fileName === 'requirements.txt') {
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('-'))
      // Strip version specifiers and extras: 'fastapi[all]>=0.115.0' -> 'fastapi'
      .map((line) => (line.split(/[[<>=!~;\s]/)[0] ?? '').trim())
      .filter((name) => name.length > 0);
  }

  if (fileName === 'pyproject.toml' || fileName === 'Pipfile') {
    // Dependency lines in either TOML layout, without a full TOML parser.
    const names = new Set<string>();
    for (const line of contents.split(/\r?\n/)) {
      const quoted = /^\s*["']?([A-Za-z0-9_.-]+)["']?\s*=/.exec(line);
      if (quoted?.[1] !== undefined) names.add(quoted[1]);
      const listed = /^\s*["']([A-Za-z0-9_.-]+)\s*[[<>=!~]/.exec(line);
      if (listed?.[1] !== undefined) names.add(listed[1]);
    }
    return [...names];
  }

  if (fileName === 'go.mod') {
    return contents
      .split(/\r?\n/)
      .map((line) => /^\s*(?:require\s+)?([a-z0-9./-]+\.[a-z]{2,}\/[^\s]+)\s+v/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
  }

  if (fileName === 'Gemfile') {
    return contents
      .split(/\r?\n/)
      .map((line) => /^\s*gem\s+["']([^"']+)["']/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
  }

  if (fileName === 'composer.json') {
    try {
      const parsed: unknown = JSON.parse(contents);
      if (parsed === null || typeof parsed !== 'object') return [];
      const names: string[] = [];
      for (const field of ['require', 'require-dev'] as const) {
        const section = (parsed as Record<string, unknown>)[field];
        if (section !== null && typeof section === 'object') names.push(...Object.keys(section));
      }
      return names;
    } catch {
      return [];
    }
  }

  if (fileName === 'pom.xml' || fileName.startsWith('build.gradle')) {
    const names = new Set<string>();
    for (const match of contents.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
    for (const match of contents.matchAll(/["']([a-z0-9.]+:[a-z0-9.-]+)(?::[^"']*)?["']/gi)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
    return [...names];
  }

  if (fileName === 'Cargo.toml') {
    return contents
      .split(/\r?\n/)
      .map((line) => /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
  }

  return [];
}

/**
 * Identify every technology in the repo, across all workspaces.
 *
 * The point of detecting technologies docgen cannot parse is that silence is
 * indistinguishable from a clean result. A Rails repo must be told that docgen
 * produced nothing because it has no Rails support, not left to assume the repo
 * has no routes.
 */
export async function detectStack(args: {
  root: string;
  exclude: readonly string[];
}): Promise<StackReport> {
  const workspaces = await findWorkspaces(args.root, args.exclude);
  const found = new Map<string, DetectedTechnology>();

  // Dependency-based signatures, per workspace.
  for (const workspace of workspaces) {
    for (const manifest of workspace.manifests) {
      const relative = workspace.dir === '' ? manifest : `${workspace.dir}/${manifest}`;
      const contents = await readIfPresent(path.join(args.root, relative));
      if (contents === undefined) continue;

      const dependencies = new Set(parseManifestDependencies(manifest, contents));
      if (dependencies.size === 0) continue;

      for (const signature of TECH_SIGNATURES) {
        if (signature.dependencies === undefined) continue;
        if (!signature.dependencies.some((name) => dependencies.has(name))) continue;

        record(found, {
          id: signature.id,
          name: signature.name,
          category: signature.category,
          workspace: workspace.dir,
          evidence: { file: relative },
          covers: signature.covers,
          ...(signature.unsupportedNote === undefined
            ? {}
            : { unsupportedNote: signature.unsupportedNote }),
        });
      }
    }
  }

  // File-based signatures, across the whole repo.
  const fileSignatures = TECH_SIGNATURES.filter((signature) => signature.files !== undefined);
  if (fileSignatures.length > 0) {
    const patterns = fileSignatures.flatMap((signature) => signature.files ?? []);
    const matches = (
      await fg(patterns, { cwd: args.root, ignore: [...args.exclude], onlyFiles: true, dot: false })
    )
      .map(toPosix)
      .sort();

    for (const signature of fileSignatures) {
      const hit = matches.find((match) =>
        (signature.files ?? []).some((pattern) => matchesGlobish(match, pattern)),
      );
      if (hit === undefined) continue;

      record(found, {
        id: signature.id,
        name: signature.name,
        category: signature.category,
        workspace: path.posix.dirname(hit) === '.' ? '' : path.posix.dirname(hit),
        evidence: { file: hit },
        covers: signature.covers,
        ...(signature.unsupportedNote === undefined
          ? {}
          : { unsupportedNote: signature.unsupportedNote }),
      });
    }
  }

  const technologies = [...found.values()].sort(
    (a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id),
  );

  return {
    workspaces,
    technologies,
    // Only frameworks and ORMs represent a coverage gap. A language or a
    // datastore is context: knowing a repo talks to Redis is useful, but
    // "docgen cannot document PostgreSQL" is a meaningless warning that would
    // train users to ignore the ones that matter.
    unsupported: technologies.filter(
      (tech) =>
        tech.covers.length === 0 && (tech.category === 'web-framework' || tech.category === 'orm'),
    ),
  };
}

/** First detection of a technology wins, so evidence points at the outermost workspace. */
function record(into: Map<string, DetectedTechnology>, tech: DetectedTechnology): void {
  const key = `${tech.id}@${tech.workspace}`;
  if (!into.has(key)) into.set(key, tech);
}

/** Cheap suffix/segment match; the glob has already filtered the candidate set. */
function matchesGlobish(file: string, pattern: string): boolean {
  if (!pattern.includes('*')) return file === pattern || file.endsWith(`/${pattern}`);
  const tail = pattern.split('*').pop() ?? '';
  return tail === '' || file.endsWith(tail.replace(/^[/]/, '')) || file.includes(tail);
}
