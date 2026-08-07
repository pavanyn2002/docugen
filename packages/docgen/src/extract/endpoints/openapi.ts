import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap } from '../../types/core.js';
import type { EndpointEntry } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';

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
}): Promise<SpecCrossCheck> {
  const files = (
    await fg(SPEC_FILES, { cwd: args.root, ignore: [...args.exclude], onlyFiles: true })
  )
    .map(toPosix)
    .sort();

  const operations: SpecOperation[] = [];
  const gaps: Gap[] = [];
  let specFound = false;

  for (const relative of files) {
    const contents = await fs.readFile(path.join(args.root, relative), 'utf8');
    const parsed = relative.endsWith('.json')
      ? parseJsonSpec(relative, contents, gaps)
      : parseYamlSpecPaths(contents);
    if (parsed.length > 0) specFound = true;
    operations.push(...parsed);
  }

  // swagger-jsdoc keeps the spec in comments beside the handlers.
  const annotations = await readJsDocAnnotations(args.root, args.exclude);
  if (annotations.length > 0) specFound = true;
  operations.push(...annotations);

  if (!specFound) return { annotated: args.entries, gaps: [], specFound: false };

  const specKeys = new Set(operations.map((operation) => key(operation.method, operation.path)));
  const codeKeys = new Set(args.entries.map((entry) => key(entry.method, entry.path)));

  const annotated = args.entries.map((entry) => ({
    ...entry,
    specStatus: specKeys.has(key(entry.method, entry.path))
      ? ('match' as const)
      : ('undeclared' as const),
  }));

  const undeclared = annotated.filter((entry) => entry.specStatus === 'undeclared');
  if (undeclared.length > 0) {
    gaps.push({
      extractor: 'endpoints',
      kind: 'endpoint-not-in-spec',
      message:
        `${undeclared.length} endpoint(s) exist in code but are absent from the API spec: ` +
        `${undeclared.slice(0, 8).map((entry) => `${entry.method} ${entry.path}`).join(', ')}` +
        `${undeclared.length > 8 ? ', …' : ''}. The spec is incomplete.`,
    });
  }

  // A spec entry with no code behind it means the published API contract
  // describes something that does not run.
  const phantom = operations.filter((operation) => !codeKeys.has(key(operation.method, operation.path)));
  if (phantom.length > 0) {
    gaps.push({
      extractor: 'endpoints',
      kind: 'spec-endpoint-not-in-code',
      message:
        `${phantom.length} endpoint(s) are declared in the API spec but no matching handler was found: ` +
        `${phantom.slice(0, 8).map((operation) => `${operation.method} ${operation.path}`).join(', ')}` +
        `${phantom.length > 8 ? ', …' : ''}. Either the spec has rotted or docgen could not resolve those routes.`,
    });
  }

  return { annotated, gaps, specFound: true };
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
): Promise<readonly SpecOperation[]> {
  const files = (
    await fg(['**/*.{ts,js,mjs}'], { cwd: root, ignore: [...exclude], onlyFiles: true })
  )
    .map(toPosix)
    .sort();

  const operations: SpecOperation[] = [];

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
      operations.push(...parseYamlSpecPaths(`paths:\n${indentBlock(yaml)}`));
    }
  }

  return operations;
}

function indentBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim().length === 0 ? line : `  ${line}`))
    .join('\n');
}
