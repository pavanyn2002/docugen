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
 * FastAPI endpoints.
 *
 * The declaration itself is easy — a decorator with a literal path. The hard
 * part is the same one Express has: a router declares `/items` and something
 * else mounts it with `include_router(router, prefix="/api/v1")`, so a reader
 * of the router file alone sees the wrong URL. Both prefixes have to be
 * followed across modules or every endpoint is documented at the wrong path,
 * which is worse than not documenting it at all.
 */

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
]);

export interface FastApiResult {
  readonly found: boolean;
  readonly entries: readonly EndpointEntry[];
  readonly gaps: readonly Gap[];
}

const EMPTY: FastApiResult = { found: false, entries: [], gaps: [] };

interface Registration {
  readonly variable: string;
  readonly method: HttpMethod;
  readonly routePath: string;
  readonly line: number;
  readonly handler?: string;
}

interface RouterDecl {
  /** '' for a FastAPI app, or the router's own `prefix=` argument. */
  readonly ownPrefix: string;
  readonly isApp: boolean;
}

interface Include {
  /** The router the call was made on: `app` in `app.include_router(...)`. */
  readonly receiver: string;
  /** Expression passed to include_router, e.g. `router` or `items.router`. */
  readonly target: string;
  readonly prefix: string;
  readonly line: number;
}

interface FileAnalysis {
  readonly file: string;
  readonly routers: ReadonlyMap<string, RouterDecl>;
  readonly registrations: readonly Registration[];
  readonly includes: readonly Include[];
  readonly imports: ReadonlyMap<string, string>;
}

/** `X = APIRouter(prefix="/items")` / `X = FastAPI()`. */
const ROUTER_DECL = /^[ \t]*(\w+)[ \t]*=[ \t]*(FastAPI|APIRouter)[ \t]*\(([\s\S]*?)\)/gm;

/** `@router.get("/x", ...)` — the decorator that declares a route. */
const DECORATOR = /^[ \t]*@(\w+)\.(\w+)[ \t]*\(\s*(["'])([^"']*)\3/gm;

/** `app.include_router(items.router, prefix="/api")`. */
const INCLUDE = /(\w+)\.include_router\s*\(\s*([\w.]+)([\s\S]*?)\)/gm;

/** `prefix="/x"` inside a call's argument text. */
function prefixArg(argumentText: string): string {
  const match = /prefix\s*=\s*(["'])([^"']*)\1/.exec(argumentText);
  return match?.[2] ?? '';
}

export function analyseFastApiFile(file: string, rawContents: string): FileAnalysis {
  const contents = stripPythonComments(rawContents);

  const routers = new Map<string, RouterDecl>();
  ROUTER_DECL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ROUTER_DECL.exec(contents)) !== null) {
    const variable = match[1] as string;
    const kind = match[2] as string;
    routers.set(variable, {
      ownPrefix: kind === 'APIRouter' ? prefixArg(match[3] as string) : '',
      isApp: kind === 'FastAPI',
    });
  }

  const registrations: Registration[] = [];
  DECORATOR.lastIndex = 0;
  while ((match = DECORATOR.exec(contents)) !== null) {
    const variable = match[1] as string;
    const verb = (match[2] as string).toLowerCase();
    if (!HTTP_METHODS.has(verb)) continue;

    const line = lineOf(contents, match.index);
    // The decorated function is the handler; it is the next def after this.
    const after = contents.slice(match.index);
    const handler = /^\s*(?:async[ \t]+)?def[ \t]+(\w+)/m.exec(after.replace(/^[^\n]*\n/, ''));

    registrations.push({
      variable,
      method: verb.toUpperCase() as HttpMethod,
      routePath: match[4] as string,
      line,
      ...(handler?.[1] === undefined ? {} : { handler: handler[1] }),
    });
  }

  const includes: Include[] = [];
  INCLUDE.lastIndex = 0;
  while ((match = INCLUDE.exec(contents)) !== null) {
    includes.push({
      receiver: match[1] as string,
      target: match[2] as string,
      prefix: prefixArg(match[3] as string),
      line: lineOf(contents, match.index),
    });
  }

  return { file, routers, registrations, includes, imports: readPythonImports(contents) };
}

export async function extractFastApiEndpoints(args: {
  root: string;
  exclude: readonly string[];
}): Promise<FastApiResult> {
  const files = (
    await fg(['**/*.py'], { cwd: args.root, ignore: [...args.exclude], onlyFiles: true })
  )
    .map(toPosix)
    .sort(compareStrings);

  if (files.length === 0) return EMPTY;

  const fileSet = new Set(files);
  const analyses = new Map<string, FileAnalysis>();

  for (const relative of files) {
    let contents: string;
    try {
      contents = await fs.readFile(path.join(args.root, relative), 'utf8');
    } catch {
      continue;
    }
    if (!/\bfrom\s+fastapi\b|\bimport\s+fastapi\b/.test(contents)) continue;

    const analysis = analyseFastApiFile(relative, contents);
    if (analysis.routers.size === 0 && analysis.registrations.length === 0) continue;
    analyses.set(relative, analysis);
  }

  if (analyses.size === 0) return EMPTY;

  const gaps: Gap[] = [];

  /**
   * Where each (file, router variable) is mounted — the prefix contributed by
   * whatever included it, *not* counting its own `prefix=`.
   *
   * Kept separate from the router's own prefix because the two compose: a
   * router declaring `prefix="/items"` and included at `prefix="/api/v1"`
   * serves `/api/v1/items`, and only that. Seeding this map with the own
   * prefix instead made the router look mounted at both paths and documented
   * every one of its endpoints twice.
   *
   * A router included from two places genuinely does serve both, so a set.
   */
  const mounts = new Map<string, Set<string>>();
  const key = (file: string, variable: string): string => `${file}#${variable}`;

  // An app is the root of the tree: it is mounted at the origin by definition.
  for (const analysis of analyses.values()) {
    for (const [variable, decl] of analysis.routers) {
      if (decl.isApp) mounts.set(key(analysis.file, variable), new Set(['']));
    }
  }

  /** Resolve `items.router` / `router` to the file and variable it names. */
  const resolveTarget = (
    analysis: FileAnalysis,
    target: string,
  ): { file: string; variable: string } | undefined => {
    const [head, tail] = target.split('.');
    if (head === undefined) return undefined;

    // Declared in this file: `include_router(router)`.
    if (tail === undefined && analysis.routers.has(head)) {
      return { file: analysis.file, variable: head };
    }

    const specifier = analysis.imports.get(head);
    if (specifier === undefined) return undefined;

    // `from .routers import items` + `items.router`, or
    // `from .routers.items import router` + `router`.
    const moduleSpec = tail === undefined ? stripLastSegment(specifier) : specifier;
    const variable = tail ?? (specifier.split('.').pop() as string);

    const resolved = resolvePythonModule(analysis.file, moduleSpec, fileSet);
    if (resolved === undefined) return undefined;

    const targetAnalysis = analyses.get(resolved);
    if (targetAnalysis === undefined || !targetAnalysis.routers.has(variable)) return undefined;
    return { file: resolved, variable };
  };

  // Iterated to a fixed point so a router included through two hops still gets
  // the full prefix. Bounded because a cycle would otherwise never settle.
  for (let pass = 0; pass < analyses.size + 1; pass += 1) {
    let changed = false;

    for (const analysis of analyses.values()) {
      for (const include of analysis.includes) {
        const resolved = resolveTarget(analysis, include.target);
        if (resolved === undefined) {
          if (pass === 0) {
            gaps.push({
              extractor: 'endpoints',
              kind: 'include-router-unresolved',
              message:
                `include_router(${include.target}, ...) could not be followed to a router in ` +
                'this repository, so the endpoints it mounts are documented without this prefix.',
              source: { file: analysis.file, line: include.line },
            });
          }
          continue;
        }

        // The including router's *full* path is its own mount plus its own
        // prefix; that is what the included router hangs off.
        const parentVariable = include.receiver;
        const parentMounts = mounts.get(key(analysis.file, parentVariable)) ?? new Set(['']);
        const parentOwn = analysis.routers.get(parentVariable)?.ownPrefix ?? '';

        const bucket = mounts.get(key(resolved.file, resolved.variable)) ?? new Set<string>();
        for (const parentMount of parentMounts) {
          const combined = `${parentMount}${parentOwn}${include.prefix}`;
          if (!bucket.has(combined)) {
            bucket.add(combined);
            changed = true;
          }
        }
        mounts.set(key(resolved.file, resolved.variable), bucket);
      }
    }

    if (!changed) break;
  }

  const entries: EndpointEntry[] = [];

  for (const analysis of analyses.values()) {
    for (const registration of analysis.registrations) {
      // A router never included anywhere still serves its own prefix; saying
      // nothing about it would hide endpoints that exist in the file.
      const own = analysis.routers.get(registration.variable)?.ownPrefix ?? '';
      const bucket = mounts.get(key(analysis.file, registration.variable));
      const effective =
        bucket === undefined || bucket.size === 0
          ? [own]
          : [...bucket].map((mount) => `${mount}${own}`).sort(compareStrings);

      for (const prefix of [...new Set(effective)]) {
        const fullPath = joinPath(prefix, registration.routePath);
        entries.push({
          id: `endpoint:${registration.method}:${fullPath}`,
          source: { file: analysis.file, line: registration.line },
          extractionMethod: PYTHON_METHOD,
          certainty: 'low',
          method: registration.method,
          path: fullPath,
          params: pythonParams(fullPath),
          middleware: [],
          ...(registration.handler === undefined
            ? {}
            : { handler: { file: analysis.file, line: registration.line } }),
        });
      }
    }
  }

  return { found: true, entries, gaps };
}

/** `.routers.items` -> `.routers`, so a module import can be resolved. */
function stripLastSegment(specifier: string): string {
  const index = specifier.lastIndexOf('.');
  return index <= 0 ? specifier : specifier.slice(0, index);
}
