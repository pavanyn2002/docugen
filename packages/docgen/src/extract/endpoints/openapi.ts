import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap } from '../../types/core.js';
import type { EndpointEntry } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';
import type { Workspace } from '../../detect/workspaces.js';
import { owningWorkspace, workspaceLabel } from '../../detect/ownership.js';

/**
 * Cross-check against a declared OpenAPI or swagger spec.
 *
 * The spec is never treated as authoritative. Code is what runs; an annotation
 * is a claim about the code that may have rotted. Trusting a stale swagger
 * comment would emit a fabricated endpoint stamped `verified`, which is exactly
 * the failure this tool exists to prevent.
 *
 * So the spec is compared, not merged. Endpoints in code but not in the spec,
 * and endpoints in the spec but not in code, are both reported — the second is
 * usually more interesting, because it means the documented API and the running
 * API disagree and QA has been reading the wrong one.
 */

export interface SpecCrossCheck {
  readonly annotated: readonly EndpointEntry[];
  readonly gaps: readonly Gap[];
  /** Whether any spec was found at all. */
  readonly specFound: boolean;
}

/** One `METHOD path` pair declared in a spec. */
interface SpecOperation {
  readonly method: string;
  readonly path: string;
}

interface SpecDocument {
  readonly file: string;
  readonly workspace: string;
  readonly operations: readonly SpecOperation[];
}

const SPEC_FILES = [
  '**/openapi.{json,yaml,yml}',
  '**/swagger.{json,yaml,yml}',
  '**/openapi-spec.{json,yaml,yml}',
  '**/api-spec.{json,yaml,yml}',
];

const HTTP_METHOD_KEYS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

export async function crossCheckAgainstSpec(args: {
  root: string;
  exclude: readonly string[];
  entries: readonly EndpointEntry[];
  workspaces?: readonly Workspace[];
}): Promise<SpecCrossCheck> {
  const files = (
    await fg(SPEC_FILES, { cwd: args.root, ignore: [...args.exclude], onlyFiles: true })
  )
    .map(toPosix)
    .sort();

  const documents: SpecDocument[] = [];
  const gaps: Gap[] = [];
  let specFound = files.length > 0;

  for (const relative of files) {
    const contents = await fs.readFile(path.join(args.root, relative), 'utf8');
    const parsed = relative.endsWith('.json')
      ? parseJsonSpec(relative, contents, gaps)
      : parseYamlSpecPaths(contents);
    if (parsed.length > 0) specFound = true;
    if (parsed.length > 0) {
      documents.push({
        file: relative,
        workspace: owningWorkspace(relative, args.workspaces ?? [{ dir: '', manifests: [] }]),
        operations: parsed,
      });
    }
  }

  // swagger-jsdoc keeps the spec in comments beside the handlers.
  const annotations = await readJsDocAnnotations(args.root, args.exclude, args.workspaces);
  if (annotations.length > 0) specFound = true;
  documents.push(...annotations);

  if (!specFound) return { annotated: args.entries, gaps: [], specFound: false };

  const documentsByApplication = new Map<string, SpecDocument[]>();
  for (const document of documents) {
    const workspaceEntries = args.entries
      .filter((entry) => (entry.workspace ?? '') === document.workspace);
    const applications = [...new Set(
      workspaceEntries
        .map((entry) => entry.application)
        .filter((value): value is string => value !== undefined),
    )].sort();
    const nearby = applications
      .map((application) => ({ application, root: expressApplicationDirectory(application) }))
      .filter((candidate): candidate is { application: string; root: string } =>
        candidate.root !== undefined &&
        (document.file === candidate.root || document.file.startsWith(`${candidate.root}/`)),
      )
      .sort((a, b) => b.root.length - a.root.length || a.application.localeCompare(b.application));
    const longest = nearby[0]?.root.length ?? -1;
    const nearest = nearby.filter((candidate) => candidate.root.length === longest);
    const applicableApplications = nearest.length > 0
      ? nearest.map((candidate) => candidate.application)
      : applications;
    if (applicableApplications.length !== 1) {
      gaps.push({
        extractor: 'endpoints',
        kind: 'openapi-scope-ambiguous',
        message:
          `API spec '${document.file}' belongs to ${workspaceLabel(document.workspace)}, but docgen ` +
          'could not prove which runtime application it governs. It was not compared globally.',
        source: { file: document.file },
      });
      continue;
    }
    const application = applicableApplications[0] as string;
    documentsByApplication.set(application, [...(documentsByApplication.get(application) ?? []), document]);
  }

  const annotated = args.entries.map((entry): EndpointEntry => {
    if (entry.application === undefined) return entry;
    const applicable = documentsByApplication.get(entry.application);
    if (applicable === undefined) return entry;
    const specKeys = new Set(
      applicable.flatMap((document) => document.operations).map((operation) => key(operation.method, operation.path)),
    );
    return { ...entry, specStatus: specKeys.has(key(entry.method, entry.path)) ? 'match' : 'undeclared' };
  });

  for (const [application, applicable] of documentsByApplication) {
    const codeEntries = annotated.filter((entry) => entry.application === application);
    const operations = applicable.flatMap((document) => document.operations);
    const specIdentity = applicable.map((document) => document.file).sort().join(', ');
    const workspace = applicable[0]?.workspace ?? '';
    const undeclared = codeEntries.filter((entry) => entry.specStatus === 'undeclared');
    if (undeclared.length > 0) {
      gaps.push({
        extractor: 'endpoints',
        kind: 'endpoint-not-in-spec',
        message:
          `${workspaceLabel(workspace)} API spec (${specIdentity}) omits ${undeclared.length} code endpoint(s): ` +
          `${undeclared.slice(0, 8).map((entry) => `${entry.method} ${entry.path}`).join(', ')}` +
          `${undeclared.length > 8 ? ', …' : ''}. The spec is incomplete.`,
        source: { file: applicable[0]?.file as string },
      });
    }
    const codeKeys = new Set(codeEntries.map((entry) => key(entry.method, entry.path)));
    const phantom = operations.filter((operation) => !codeKeys.has(key(operation.method, operation.path)));
    if (phantom.length > 0) {
      gaps.push({
        extractor: 'endpoints',
        kind: 'spec-endpoint-not-in-code',
        message:
          `${workspaceLabel(workspace)} API spec (${specIdentity}) declares ${phantom.length} endpoint(s) with no matching handler: ` +
          `${phantom.slice(0, 8).map((operation) => `${operation.method} ${operation.path}`).join(', ')}` +
          `${phantom.length > 8 ? ', …' : ''}. Either the spec has rotted or docgen could not resolve those routes.`,
        source: { file: applicable[0]?.file as string },
      });
    }
  }

  return { annotated, gaps, specFound: true };
}

function expressApplicationDirectory(application: string): string | undefined {
  const marker = ':express:';
  const offset = application.indexOf(marker);
  if (offset < 0) return undefined;
  const file = application.slice(offset + marker.length).split('#')[0];
  if (file === undefined) return undefined;
  const directory = path.posix.dirname(file);
  return directory === '.' ? '' : directory;
}

function key(method: string, routePath: string): string {
  // Parameter names differ freely between a spec and the code ({id} vs :orderId),
  // so paths are compared by shape rather than by parameter naming.
  const normalised = routePath
    .split('/')
    .map((segment) =>
      segment.startsWith(':') || /^[[{].*[\]}]$/.test(segment) ? '*' : segment.toLowerCase(),
    )
    .join('/');
  return `${method.toUpperCase()} ${normalised}`;
}

function parseJsonSpec(file: string, contents: string, gaps: Gap[]): readonly SpecOperation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    gaps.push({
      extractor: 'endpoints',
      kind: 'spec-unparseable',
      message: 'An API spec file is not valid JSON and was not cross-checked.',
      source: { file },
    });
    return [];
  }
  return operationsFromPathsObject(parsed);
}

function operationsFromPathsObject(parsed: unknown): readonly SpecOperation[] {
  if (parsed === null || typeof parsed !== 'object') return [];
  const paths = (parsed as Record<string, unknown>)['paths'];
  if (paths === null || typeof paths !== 'object') return [];

  const operations: SpecOperation[] = [];
  for (const [routePath, methods] of Object.entries(paths as Record<string, unknown>)) {
    if (methods === null || typeof methods !== 'object') continue;
    for (const method of Object.keys(methods as Record<string, unknown>)) {
      if (HTTP_METHOD_KEYS.has(method.toLowerCase())) {
        operations.push({ method, path: routePath });
      }
    }
  }
  return operations;
}

/**
 * Read `paths:` from a YAML spec without a YAML parser.
 *
 * Only the path/method structure is needed, and that structure is strictly
 * indentation-based, so this reads it directly rather than adding a YAML
 * dependency for two levels of keys.
 */
export function parseYamlSpecPaths(contents: string): readonly SpecOperation[] {
  const lines = contents.split(/\r?\n/);
  const operations: SpecOperation[] = [];

  let inPaths = false;
  let pathsIndent = 0;
  let currentPath: string | undefined;
  let pathIndent = 0;

  for (const line of lines) {
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (!inPaths) {
      if (/^paths\s*:/.test(trimmed)) {
        inPaths = true;
        pathsIndent = indent;
      }
      continue;
    }

    if (indent <= pathsIndent) break; // paths block ended

    const pathKey = /^(['"]?)(\/[^'":]*)\1\s*:/.exec(trimmed);
    if (pathKey?.[2] !== undefined && (currentPath === undefined || indent <= pathIndent)) {
      currentPath = pathKey[2];
      pathIndent = indent;
      continue;
    }

    if (currentPath !== undefined && indent > pathIndent) {
      const methodKey = /^([a-zA-Z]+)\s*:/.exec(trimmed);
      const method = methodKey?.[1]?.toLowerCase();
      if (method !== undefined && HTTP_METHOD_KEYS.has(method)) {
        operations.push({ method, path: currentPath });
      }
    }
  }

  return operations;
}

/** `@openapi` / `@swagger` JSDoc blocks, as used by swagger-jsdoc. */
async function readJsDocAnnotations(
  root: string,
  exclude: readonly string[],
  workspaces?: readonly Workspace[],
): Promise<readonly SpecDocument[]> {
  const files = (
    await fg(['**/*.{ts,js,mjs}'], { cwd: root, ignore: [...exclude], onlyFiles: true })
  )
    .map(toPosix)
    .sort();

  const documents: SpecDocument[] = [];

  for (const relative of files) {
    let contents: string;
    try {
      contents = await fs.readFile(path.join(root, relative), 'utf8');
    } catch {
      continue;
    }
    if (!contents.includes('@openapi') && !contents.includes('@swagger')) continue;

    for (const block of contents.matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
      const body = block[1] ?? '';
      if (!/@(?:openapi|swagger)\b/.test(body)) continue;
      // Strip leading ' * ' so the YAML inside the block reads normally.
      const yaml = body
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*\*ic?\s?/, '').replace(/^\s*\*\s?/, ''))
        .filter((line) => !/@(?:openapi|swagger)\b/.test(line))
        .join('\n');
      const operations = parseYamlSpecPaths(`paths:\n${indentBlock(yaml)}`);
      if (operations.length > 0) {
        documents.push({
          file: relative,
          workspace: owningWorkspace(relative, workspaces ?? [{ dir: '', manifests: [] }]),
          operations,
        });
      }
    }
  }

  return documents;
}

function indentBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim().length === 0 ? line : `  ${line}`))
    .join('\n');
}
