import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap, SourceRef } from '../../types/core.js';
import type { EndpointEntry, OpenApiCrossCheckSummary } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';
import { compareStrings } from '../../util/sort.js';
import type { Workspace } from '../../detect/workspaces.js';
import { owningWorkspace, workspaceLabel } from '../../detect/ownership.js';
import type { ExpressSourceOwnership } from './express.js';
import { joinPath } from './paths.js';

export interface SpecCrossCheck {
  readonly annotated: readonly EndpointEntry[];
  readonly gaps: readonly Gap[];
  readonly specFound: boolean;
  readonly summary?: OpenApiCrossCheckSummary;
}

interface SpecOperation {
  readonly method: string;
  readonly path: string;
}

interface SpecDocument {
  readonly file: string;
  readonly line?: number;
  readonly workspace: string;
  readonly kind: 'standalone' | 'inline';
  readonly operations: readonly SpecOperation[];
}

interface ScopedDocument extends SpecDocument {
  readonly application: string;
  readonly operations: readonly SpecOperation[];
}

const SPEC_FILES = [
  '**/openapi.{json,yaml,yml}', '**/swagger.{json,yaml,yml}',
  '**/openapi-spec.{json,yaml,yml}', '**/api-spec.{json,yaml,yml}',
];
const HTTP_METHOD_KEYS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

export async function crossCheckAgainstSpec(args: {
  root: string;
  exclude: readonly string[];
  entries: readonly EndpointEntry[];
  workspaces?: readonly Workspace[];
  expressOwnership?: readonly ExpressSourceOwnership[];
}): Promise<SpecCrossCheck> {
  const files = (await fg(SPEC_FILES, { cwd: args.root, ignore: [...args.exclude], onlyFiles: true }))
    .map(toPosix).sort(compareStrings);
  const documents: SpecDocument[] = [];
  const gaps: Gap[] = [];
  const workspaces = args.workspaces ?? [{ dir: '', manifests: [] }];

  for (const relative of files) {
    const contents = await fs.readFile(path.join(args.root, relative), 'utf8');
    const parsed = relative.endsWith('.json')
      ? parseJsonSpec(relative, contents, gaps)
      : parseYamlSpecPaths(contents);
    if (parsed.length > 0) documents.push({
      file: relative, workspace: owningWorkspace(relative, workspaces), kind: 'standalone',
      operations: sortedOperations(parsed),
    });
  }
  documents.push(...await readJsDocAnnotations(args.root, args.exclude, workspaces));
  const specFound = files.length > 0 || documents.some((document) => document.kind === 'inline');
  if (!specFound) return { annotated: args.entries, gaps: [], specFound: false };

  const ownershipByFile = new Map((args.expressOwnership ?? []).map((item) => [item.file, item]));
  const scoped: ScopedDocument[] = [];
  const ambiguityKeys = new Set<string>();
  let operationsSkippedAmbiguous = 0;
  const ambiguousDocuments = new Set<string>();

  const addAmbiguity = (document: SpecDocument, reason: string, application?: string): void => {
    const key = `${document.workspace}\u0000${document.file}\u0000${application ?? ''}\u0000${reason}`;
    if (ambiguityKeys.has(key)) return;
    ambiguityKeys.add(key);
    ambiguousDocuments.add(`${document.workspace}\u0000${document.file}`);
    operationsSkippedAmbiguous += document.operations.length;
    gaps.push({
      extractor: 'endpoints', kind: 'openapi-scope-ambiguous',
      message: `API document '${document.file}' in ${workspaceLabel(document.workspace)} was not compared because ${reason}` +
        `${application === undefined ? '' : ` (application '${application}')`}. Its operations remain unannotated.`,
      source: { file: document.file, ...(document.line === undefined ? {} : { line: document.line }) },
    });
  };

  for (const document of documents) {
    if (document.kind === 'inline') {
      const ownership = ownershipByFile.get(document.file);
      if (ownership === undefined || ownership.applications.length === 0) {
        addAmbiguity(document, 'its source router is not mounted into a provable runtime application');
        continue;
      }
      const ownedApplications = new Set(ownership.applications.map((location) => location.application));
      if (
        ownedApplications.size > 1 &&
        ownership.applications.every((location) => location.origin === 'application')
      ) {
        addAmbiguity(document, 'the source file declares multiple application roots and no router ownership distinguishes them');
        continue;
      }
      const byApplication = new Map<string, typeof ownership.applications>();
      for (const location of ownership.applications) {
        byApplication.set(location.application, [...(byApplication.get(location.application) ?? []), location]);
      }
      for (const [application, locations] of [...byApplication].sort(([a], [b]) => compareStrings(a, b))) {
        const operations = sortedOperations(locations.flatMap((location) =>
          document.operations.map((operation) => ({
            ...operation,
            path: applyMountPrefix(location.prefix, operation.path),
          })),
        ));
        scoped.push({ ...document, application, operations });
      }
      continue;
    }

    const applications = [...new Set(args.entries
      .filter((entry) => (entry.workspace ?? '') === document.workspace)
      .map((entry) => entry.application)
      .filter((value): value is string => value !== undefined))].sort(compareStrings);
    const nearest = nearestApplications(document.file, applications);
    const applicable = nearest.length > 0 ? nearest : applications;
    if (applicable.length !== 1) {
      addAmbiguity(document, 'no single owning runtime application could be proven');
      continue;
    }
    scoped.push({ ...document, application: applicable[0] as string });
  }

  const byApplication = new Map<string, ScopedDocument[]>();
  for (const document of scoped) {
    byApplication.set(document.application, [...(byApplication.get(document.application) ?? []), document]);
  }
  for (const docs of byApplication.values()) docs.sort((a, b) => compareStrings(a.file, b.file));

  let operationsCompared = 0;
  let codeEndpointsAbsent = 0;
  let specOperationsWithoutHandlers = 0;
  const annotated = args.entries.map((entry): EndpointEntry => {
    if (entry.application === undefined) return entry;
    const applicable = byApplication.get(entry.application);
    if (applicable === undefined) return entry;
    const specKeys = new Set(applicable.flatMap((document) => document.operations)
      .map((operation) => operationKey(operation.method, operation.path)));
    const entryKey = operationKey(entry.method, entry.path);
    const matchingDocuments = applicable.filter((document) =>
      document.operations.some((operation) => operationKey(operation.method, operation.path) === entryKey));
    const sourceDocuments = matchingDocuments.length > 0 ? matchingDocuments : applicable;
    const sources = uniqueSources(sourceDocuments.map((document) => ({
      file: document.file,
      ...(document.line === undefined ? {} : { line: document.line }),
    })));
    return {
      ...entry,
      specStatus: specKeys.has(entryKey) ? 'match' : 'undeclared',
      openApiSources: sources,
    };
  });

  for (const [application, applicable] of [...byApplication].sort(([a], [b]) => compareStrings(a, b))) {
    const codeEntries = annotated.filter((entry) => entry.application === application && entry.finalPathResolved !== false);
    const operations = sortedOperations(applicable.flatMap((document) => document.operations));
    operationsCompared += operations.length;
    const specIdentity = [...new Set(applicable.map((document) => document.file))].sort(compareStrings).join(', ');
    const workspace = applicable[0]?.workspace ?? '';
    const undeclared = codeEntries.filter((entry) => entry.specStatus === 'undeclared');
    codeEndpointsAbsent += undeclared.length;
    if (undeclared.length > 0) gaps.push({
      extractor: 'endpoints', kind: 'endpoint-not-in-spec',
      message: `${workspaceLabel(workspace)} API document(s) (${specIdentity}) omit ${undeclared.length} code endpoint(s) in application '${application}': ` +
        `${undeclared.slice(0, 8).map((entry) => `${entry.method} ${entry.path}`).join(', ')}${undeclared.length > 8 ? ', …' : ''}.`,
      source: { file: applicable[0]?.file as string },
    });
    const codeKeys = new Set(codeEntries.map((entry) => operationKey(entry.method, entry.path)));
    const phantom = operations.filter((operation) => !codeKeys.has(operationKey(operation.method, operation.path)));
    specOperationsWithoutHandlers += phantom.length;
    if (phantom.length > 0) gaps.push({
      extractor: 'endpoints', kind: 'spec-endpoint-not-in-code',
      message: `${workspaceLabel(workspace)} API document(s) (${specIdentity}) declare ${phantom.length} operation(s) with no matching handler in application '${application}': ` +
        `${phantom.slice(0, 8).map((operation) => `${operation.method.toUpperCase()} ${operation.path}`).join(', ')}${phantom.length > 8 ? ', …' : ''}.`,
      source: { file: applicable[0]?.file as string },
    });
  }

  const summary: OpenApiCrossCheckSummary = {
    operationsCompared, codeEndpointsAbsent, specOperationsWithoutHandlers,
    operationsSkippedAmbiguous, ambiguousDocuments: ambiguousDocuments.size,
    documentsParsed: documents.length,
  };
  return { annotated, gaps: dedupeGaps(gaps), specFound: true, summary };
}

function nearestApplications(file: string, applications: readonly string[]): readonly string[] {
  const nearby = applications
    .map((application) => ({ application, root: expressApplicationDirectory(application) }))
    .filter((candidate): candidate is { application: string; root: string } =>
      candidate.root !== undefined && (file === candidate.root || file.startsWith(`${candidate.root}/`)))
    .sort((a, b) => b.root.length - a.root.length || compareStrings(a.application, b.application));
  const longest = nearby[0]?.root.length ?? -1;
  return nearby.filter((candidate) => candidate.root.length === longest).map((candidate) => candidate.application);
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

function applyMountPrefix(prefix: string, operationPath: string): string {
  if (prefix === '' || prefix === '/') return operationPath;
  const normalPrefix = joinPath('', prefix);
  if (operationPath === normalPrefix || operationPath.startsWith(`${normalPrefix}/`)) return operationPath;
  return joinPath(prefix, operationPath);
}

function operationKey(method: string, routePath: string): string {
  const normalised = routePath.split('/').map((segment) =>
    segment.startsWith(':') || /^(?:\{.*\}|\[.*\])$/.test(segment) ? '*' : segment.toLowerCase(),
  ).join('/');
  return `${method.toUpperCase()} ${normalised}`;
}

function parseJsonSpec(file: string, contents: string, gaps: Gap[]): readonly SpecOperation[] {
  try {
    return operationsFromPathsObject(JSON.parse(contents));
  } catch {
    gaps.push({
      extractor: 'endpoints', kind: 'spec-unparseable',
      message: 'An API spec file is not valid JSON and was not cross-checked.', source: { file },
    });
    return [];
  }
}

function operationsFromPathsObject(parsed: unknown): readonly SpecOperation[] {
  if (parsed === null || typeof parsed !== 'object') return [];
  const paths = (parsed as Record<string, unknown>)['paths'];
  if (paths === null || typeof paths !== 'object') return [];
  const operations: SpecOperation[] = [];
  for (const [routePath, methods] of Object.entries(paths as Record<string, unknown>)) {
    if (methods === null || typeof methods !== 'object') continue;
    for (const method of Object.keys(methods as Record<string, unknown>)) {
      if (HTTP_METHOD_KEYS.has(method.toLowerCase())) operations.push({ method, path: routePath });
    }
  }
  return sortedOperations(operations);
}

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
      if (/^paths\s*:/.test(trimmed)) { inPaths = true; pathsIndent = indent; }
      continue;
    }
    if (indent <= pathsIndent) break;
    const pathKey = /^(['"]?)(\/[^'":]*)\1\s*:/.exec(trimmed);
    if (pathKey?.[2] !== undefined && (currentPath === undefined || indent <= pathIndent)) {
      currentPath = pathKey[2]; pathIndent = indent; continue;
    }
    if (currentPath !== undefined && indent > pathIndent) {
      const method = /^([a-zA-Z]+)\s*:/.exec(trimmed)?.[1]?.toLowerCase();
      if (method !== undefined && HTTP_METHOD_KEYS.has(method)) operations.push({ method, path: currentPath });
    }
  }
  return sortedOperations(operations);
}

async function readJsDocAnnotations(
  root: string,
  exclude: readonly string[],
  workspaces: readonly Workspace[],
): Promise<readonly SpecDocument[]> {
  const files = (await fg(['**/*.{ts,js,mjs}'], { cwd: root, ignore: [...exclude], onlyFiles: true }))
    .map(toPosix).sort(compareStrings);
  const documents: SpecDocument[] = [];
  for (const relative of files) {
    let contents: string;
    try { contents = await fs.readFile(path.join(root, relative), 'utf8'); } catch { continue; }
    if (!contents.includes('@openapi') && !contents.includes('@swagger')) continue;
    const operations: SpecOperation[] = [];
    let firstLine: number | undefined;
    for (const block of contents.matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
      const body = block[1] ?? '';
      if (!/@(?:openapi|swagger)\b/.test(body)) continue;
      firstLine ??= contents.slice(0, block.index).split(/\r?\n/).length;
      const yaml = body.split(/\r?\n/)
        .map((line) => line.replace(/^\s*\*\s?/, ''))
        .filter((line) => !/@(?:openapi|swagger)\b/.test(line)).join('\n');
      operations.push(...parseYamlSpecPaths(`paths:\n${indentBlock(yaml)}`));
    }
    if (operations.length > 0) documents.push({
      file: relative, ...(firstLine === undefined ? {} : { line: firstLine }),
      workspace: owningWorkspace(relative, workspaces), kind: 'inline',
      operations: sortedOperations(operations),
    });
  }
  return documents;
}

function indentBlock(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim().length === 0 ? line : `  ${line}`).join('\n');
}

function sortedOperations(operations: readonly SpecOperation[]): readonly SpecOperation[] {
  const unique = new Map<string, SpecOperation>();
  for (const operation of operations) unique.set(`${operation.method.toUpperCase()}\u0000${operation.path}`, operation);
  return [...unique.values()].sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.method.toUpperCase(), b.method.toUpperCase()));
}

function uniqueSources(sources: readonly SourceRef[]): readonly SourceRef[] {
  const unique = new Map<string, SourceRef>();
  for (const source of sources) unique.set(`${source.file}\u0000${source.line ?? 0}`, source);
  return [...unique.values()].sort((a, b) => compareStrings(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0));
}

function dedupeGaps(gaps: readonly Gap[]): readonly Gap[] {
  const unique = new Map<string, Gap>();
  for (const gap of gaps) unique.set(`${gap.kind}\u0000${gap.source?.file ?? ''}\u0000${gap.source?.line ?? 0}\u0000${gap.message}`, gap);
  return [...unique.values()].sort((a, b) => compareStrings(a.kind, b.kind) || compareStrings(a.source?.file ?? '', b.source?.file ?? '') || compareStrings(a.message, b.message));
}
