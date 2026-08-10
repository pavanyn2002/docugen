import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap } from '../../types/core.js';
import type { EndpointEntry, HttpMethod } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';
import { compareStrings } from '../../util/sort.js';
import { joinPath } from './paths.js';
import {
  lineOf,
  PYTHON_METHOD,
  pythonParams,
  readPythonImports,
  resolvePythonModule,
  stripPythonComments,
} from './python.js';

/**
 * Django URL configuration.
 *
 * Two things make this different from every other endpoint extractor.
 *
 * The URL tree is assembled through `include()`, so a path in an app's
 * `urls.py` is only half the address — the project's root urlconf supplies the
 * rest. Following that is the whole job, exactly as with an Express mount.
 *
 * And a Django URL carries no HTTP method: the view decides which verbs it
 * answers. Where the view says so in a way that can be read — an `@api_view`
 * list, or the handler methods of a class-based view — those verbs are
 * recorded. Where it does not, the endpoint is `ALL` and a gap says the method
 * set was not determined. Writing `GET` because most views are GET would be a
 * claim nothing in the code supports.
 */

export interface DjangoResult {
  readonly found: boolean;
  readonly entries: readonly EndpointEntry[];
  readonly gaps: readonly Gap[];
}

const EMPTY: DjangoResult = { found: false, entries: [], gaps: [] };

/**
 * `path('x/', view)` and `re_path(r'^x$', view)`.
 *
 * The view is captured up to the next comma rather than the next paren, because
 * `views.PostDetail.as_view()` carries parens of its own — stopping at the first
 * one truncated the name to `views.PostDetail.as_view(` and produced a broken
 * pattern downstream.
 */
const URL_ENTRY = /\b(path|re_path|url)\s*\(\s*(?:r?)(["'])([^"']*)\2\s*,\s*([^,]+)/gm;

/** `include('app.urls')` or `include(other)` inside the second argument. */
const INCLUDE_CALL = /^\s*include\s*\(\s*(?:(["'])([^"']*)\1|([\w.]+))/;

const VIEW_METHODS: ReadonlySet<string> = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
]);

interface UrlRow {
  readonly rawPath: string;
  readonly target: string;
  readonly line: number;
  readonly isRegex: boolean;
}

interface UrlFile {
  readonly file: string;
  readonly rows: readonly UrlRow[];
  readonly imports: ReadonlyMap<string, string>;
}

/** Normalise a Django pattern to a URL path docgen can print. */
export function normaliseDjangoPath(rawPath: string, isRegex: boolean): string {
  if (!isRegex) return `/${rawPath}`.replace(/\/+/g, '/');
  // `^users/(?P<pk>\d+)/$` -> `/users/<pk>/`
  const named = rawPath
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\(\?P<(\w+)>[^)]*\)/g, '<$1>')
    .replace(/\([^)]*\)/g, '<unnamed>');
  return `/${named}`.replace(/\/+/g, '/');
}

export function analyseUrlFile(file: string, rawContents: string): UrlFile {
  const contents = stripPythonComments(rawContents);
  const rows: UrlRow[] = [];

  URL_ENTRY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_ENTRY.exec(contents)) !== null) {
    rows.push({
      rawPath: match[3] as string,
      target: trimUnbalanced((match[4] as string).trim()),
      line: lineOf(contents, match.index),
      isRegex: match[1] !== 'path',
    });
  }

  return { file, rows, imports: readPythonImports(contents) };
}

/**
 * Verbs a view answers, when the view says so plainly.
 *
 * Returns an empty list when it does not, which the caller turns into a gap
 * rather than a guess.
 */
export function methodsOfView(source: string, viewName: string): readonly HttpMethod[] {
  const stripped = stripPythonComments(source);
  // The name comes from the target repo's source, so it is escaped before being
  // built into a pattern. An unescaped one is a hard crash on input as ordinary
  // as `views.PostDetail.as_view()`.
  const name = escapeForRegExp(viewName);

  // @api_view(["GET", "POST"]) above a function view.
  const decorated = new RegExp(
    `@api_view\\s*\\(\\s*\\[([^\\]]*)\\][\\s\\S]{0,200}?def\\s+${name}\\b`,
  ).exec(stripped);
  if (decorated?.[1] !== undefined) {
    const verbs = [...decorated[1].matchAll(/["'](\w+)["']/g)]
      .map((entry) => (entry[1] as string).toUpperCase())
      .filter((verb) => VIEW_METHODS.has(verb.toLowerCase()));
    if (verbs.length > 0) return [...new Set(verbs)] as HttpMethod[];
  }

  // A class-based view: its handler methods are the verbs it answers.
  const classBody = new RegExp(`class\\s+${name}\\b[^\\n]*:\\n([\\s\\S]*?)(?=\\nclass\\s|$)`).exec(
    stripped,
  );
  if (classBody?.[1] !== undefined) {
    const verbs = [...classBody[1].matchAll(/^\s{4}(?:async\s+)?def\s+(\w+)\s*\(/gm)]
      .map((entry) => (entry[1] as string).toLowerCase())
      .filter((name) => VIEW_METHODS.has(name))
      .map((name) => name.toUpperCase() as HttpMethod);
    if (verbs.length > 0) return [...new Set(verbs)];
  }

  return [];
}

export async function extractDjangoEndpoints(args: {
  root: string;
  exclude: readonly string[];
}): Promise<DjangoResult> {
  const files = (
    await fg(['**/*.py'], { cwd: args.root, ignore: [...args.exclude], onlyFiles: true })
  )
    .map(toPosix)
    .sort(compareStrings);

  if (files.length === 0) return EMPTY;

  const fileSet = new Set(files);
  const sources = new Map<string, string>();
  const urlFiles = new Map<string, UrlFile>();

  for (const relative of files) {
    let contents: string;
    try {
      contents = await fs.readFile(path.join(args.root, relative), 'utf8');
    } catch {
      continue;
    }
    sources.set(relative, contents);
    if (!/\burlpatterns\b/.test(contents)) continue;
    if (!/django/.test(contents)) continue;
    urlFiles.set(relative, analyseUrlFile(relative, contents));
  }

  if (urlFiles.size === 0) return EMPTY;

  const gaps: Gap[] = [];

  /** Every urlconf that some other urlconf includes — the rest are roots. */
  const included = new Set<string>();
  for (const urlFile of urlFiles.values()) {
    for (const row of urlFile.rows) {
      const target = resolveInclude(urlFile, row, fileSet);
      if (target !== undefined) included.add(target);
    }
  }

  const roots = [...urlFiles.keys()].filter((file) => !included.has(file)).sort(compareStrings);
  const entries: EndpointEntry[] = [];
  const seen = new Set<string>();

  const walk = (file: string, prefix: string, depth: number): void => {
    if (depth > 8) return;
    const urlFile = urlFiles.get(file);
    if (urlFile === undefined) return;

    for (const row of urlFile.rows) {
      const segment = normaliseDjangoPath(row.rawPath, row.isRegex);

      const includeTarget = resolveInclude(urlFile, row, fileSet);
      if (includeTarget !== undefined) {
        walk(includeTarget, joinPath(prefix, segment), depth + 1);
        continue;
      }
      if (INCLUDE_CALL.test(row.target)) {
        gaps.push({
          extractor: 'endpoints',
          kind: 'urlconf-include-unresolved',
          message:
            `include(${row.target.slice(0, 60)}) could not be followed to a urls.py in this ` +
            'repository, so the URLs below it are not documented.',
          source: { file, line: row.line },
        });
        continue;
      }

      const fullPath = joinPath(prefix, segment);
      const methods = methodsForTarget(urlFile, row.target, sources, fileSet);

      if (methods.length === 0) {
        gaps.push({
          extractor: 'endpoints',
          kind: 'view-methods-undetermined',
          message:
            `The verbs served by '${row.target}' at ${fullPath} could not be read from the view, ` +
            'so it is recorded as ALL. A Django URL carries no method — the view decides.',
          source: { file, line: row.line },
        });
      }

      for (const method of methods.length === 0 ? (['ALL'] as HttpMethod[]) : methods) {
        const id = `endpoint:${method}:${fullPath}`;
        if (seen.has(id)) continue;
        seen.add(id);
        entries.push({
          id,
          source: { file, line: row.line },
          extractionMethod: PYTHON_METHOD,
          certainty: 'low',
          method,
          path: fullPath,
          params: pythonParams(fullPath),
          middleware: [],
        });
      }
    }
  };

  for (const root of roots) walk(root, '', 0);

  return { found: true, entries, gaps };
}

/**
 * Drop the closing parens that belong to the enclosing `path(...)` call.
 *
 * Capturing to the next comma takes `views.post_list)` from
 * `path("posts/", views.post_list)`, and a view named `post_list)` matches
 * nothing. Balanced parens are kept, so `views.PostDetail.as_view()` survives.
 */
function trimUnbalanced(value: string): string {
  let result = value;
  for (;;) {
    const opens = (result.match(/\(/g) ?? []).length;
    const closes = (result.match(/\)/g) ?? []).length;
    if (closes <= opens || !result.endsWith(')')) return result.trim();
    result = result.slice(0, -1).trim();
  }
}

/** Make a literal safe to embed in a pattern. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The urls.py an `include(...)` names, when it can be resolved. */
function resolveInclude(
  urlFile: UrlFile,
  row: UrlRow,
  files: ReadonlySet<string>,
): string | undefined {
  const match = INCLUDE_CALL.exec(row.target);
  if (match === null) return undefined;

  const literal = match[2];
  if (literal !== undefined) return resolvePythonModule(urlFile.file, literal, files);

  const symbol = match[3];
  if (symbol === undefined) return undefined;
  const specifier = urlFile.imports.get(symbol.split('.')[0] as string);
  return specifier === undefined
    ? undefined
    : resolvePythonModule(urlFile.file, specifier, files);
}

/** Read the verbs of the view a url row points at. */
function methodsForTarget(
  urlFile: UrlFile,
  target: string,
  sources: ReadonlyMap<string, string>,
  files: ReadonlySet<string>,
): readonly HttpMethod[] {
  // `views.user_detail` / `UserView.as_view()` / `user_detail`
  const cleaned = target.replace(/\.as_view\s*\(\s*\)/, '').trim();
  const parts = cleaned.split('.');
  const viewName = parts[parts.length - 1];
  if (viewName === undefined || viewName === '') return [];

  const candidates: string[] = [];
  if (parts.length > 1) {
    const specifier = urlFile.imports.get(parts[0] as string);
    if (specifier !== undefined) {
      const resolved = resolvePythonModule(urlFile.file, specifier, files);
      if (resolved !== undefined) candidates.push(resolved);
    }
  } else {
    const specifier = urlFile.imports.get(viewName);
    if (specifier !== undefined) {
      const resolved = resolvePythonModule(
        urlFile.file,
        specifier.slice(0, specifier.lastIndexOf('.')),
        files,
      );
      if (resolved !== undefined) candidates.push(resolved);
    }
  }
  // A views module beside the urlconf is the Django convention.
  candidates.push(path.posix.join(path.posix.dirname(urlFile.file), 'views.py'));

  for (const candidate of candidates) {
    const source = sources.get(candidate);
    if (source === undefined) continue;
    const methods = methodsOfView(source, viewName);
    if (methods.length > 0) return methods;
  }
  return [];
}
