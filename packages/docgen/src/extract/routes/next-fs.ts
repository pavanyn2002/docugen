import fg from 'fast-glob';
import path from 'node:path';
import type { Gap, SourceRef } from '../../types/core.js';
import type { RouteEntry, RouteGuard, RouteKind } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';
import type { MiddlewareInfo } from './middleware.js';
import { parseAppSegments, parsePagesSegments, stripRouteExtension } from './segments.js';

export interface FsRoutesResult {
  readonly entries: readonly RouteEntry[];
  readonly gaps: readonly Gap[];
}

/** App-router special files and the route kind each produces. */
const APP_FILE_KINDS: Readonly<Record<string, RouteKind>> = Object.freeze({
  page: 'page',
  layout: 'layout',
  template: 'template',
  loading: 'loading',
  error: 'error',
  'global-error': 'error',
  'not-found': 'error',
});

/**
 * App-router files that are deliberately not routes.
 * `route` is an API handler and belongs to the endpoints extractor;
 * `default` backs a parallel slot rather than a URL.
 */
const APP_NON_ROUTE_FILES = new Set(['route', 'default']);

async function findFiles(root: string, dir: string, exclude: readonly string[]): Promise<string[]> {
  const matches = await fg('**/*.{tsx,ts,jsx,js,mjs,mdx}', {
    cwd: path.join(root, dir),
    ignore: [...exclude],
    dot: false,
    onlyFiles: true,
  });
  return matches.map(toPosix).sort();
}

/**
 * Extract routes from a Next.js App Router directory.
 *
 * Layout chains are built from directory ancestry, which is exactly how Next
 * composes them, so they are `manifest` certainty rather than inference.
 */
export async function extractAppRoutes(args: {
  root: string;
  dir: string;
  exclude: readonly string[];
  middleware?: MiddlewareInfo;
}): Promise<FsRoutesResult> {
  const files = await findFiles(args.root, args.dir, args.exclude);
  const gaps: Gap[] = [];

  // Directory (relative to the app dir) -> its layout file, for chain building.
  const layoutsByDir = new Map<string, string>();
  for (const relative of files) {
    const base = stripRouteExtension(path.posix.basename(relative));
    if (base !== 'layout') continue;
    layoutsByDir.set(path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative), relative);
  }

  const entries: RouteEntry[] = [];

  for (const relative of files) {
    const baseName = stripRouteExtension(path.posix.basename(relative));
    if (baseName === undefined) continue;
    if (APP_NON_ROUTE_FILES.has(baseName)) continue;

    const kind = APP_FILE_KINDS[baseName];
    if (kind === undefined) continue; // A colocated component, not a route file.

    const dirname = path.posix.dirname(relative);
    const segmentDir = dirname === '.' ? '' : dirname;
    const parsed = parseAppSegments(segmentDir);

    const file = toPosix(path.posix.join(args.dir, relative));
    if (parsed.isPrivate) continue; // `_folder` opts out of routing entirely.

    if (parsed.slots.length > 0) {
      gaps.push({
        extractor: 'routes',
        kind: 'parallel-route-slot',
        message:
          `This file is inside parallel route slot(s) ${parsed.slots.map((s) => `@${s}`).join(', ')}. ` +
          'Its URL depends on how the parent layout renders the slot, which is not statically determined.',
        source: { file },
      });
    }

    if (parsed.isIntercepting) {
      gaps.push({
        extractor: 'routes',
        kind: 'intercepting-route',
        message:
          'This is an intercepting route. It renders in place of another URL under conditions ' +
          'docgen does not resolve, so the path shown is the underlying segment path only.',
        source: { file },
      });
    }

    const layoutChain = buildLayoutChain(segmentDir, layoutsByDir, args.dir);
    const guards = kind === 'page' ? guardsFor(parsed.path, args.middleware) : [];

    entries.push({
      id: `route:${kind}:${parsed.path}`,
      source: { file, line: 1 },
      extractionMethod: 'manifest',
      certainty: 'high',
      path: parsed.path,
      kind,
      params: parsed.params,
      isCatchAll: parsed.isCatchAll,
      component: { file, line: 1 },
      layoutChain,
      guards,
      ...(parsed.groups.length > 0 ? { group: parsed.groups.join('/') } : {}),
    });
  }

  return { entries, gaps };
}

/** Layout files from the app root down to this directory, outermost first. */
function buildLayoutChain(
  segmentDir: string,
  layoutsByDir: ReadonlyMap<string, string>,
  appDir: string,
): readonly SourceRef[] {
  const parts = segmentDir.split('/').filter((part) => part.length > 0);
  const chain: SourceRef[] = [];

  for (let depth = 0; depth <= parts.length; depth += 1) {
    const key = parts.slice(0, depth).join('/');
    const layout = layoutsByDir.get(key);
    if (layout !== undefined) {
      chain.push({ file: toPosix(path.posix.join(appDir, layout)), line: 1 });
    }
  }
  return chain;
}

function guardsFor(routePath: string, middleware: MiddlewareInfo | undefined): readonly RouteGuard[] {
  if (middleware === undefined) return [];
  const matched = middleware.matchers.some((matcher) => matcher.test(routePath));
  return matched ? [{ name: 'middleware', source: middleware.source }] : [];
}

/**
 * Extract routes from a Next.js Pages Router directory.
 *
 * `pages/api/**` is skipped: those are API handlers, and documenting them as
 * screens would tell a QA engineer a page exists where none does.
 */
export async function extractPagesRoutes(args: {
  root: string;
  dir: string;
  exclude: readonly string[];
  middleware?: MiddlewareInfo;
}): Promise<FsRoutesResult> {
  const files = await findFiles(args.root, args.dir, args.exclude);
  const entries: RouteEntry[] = [];
  const gaps: Gap[] = [];

  for (const relative of files) {
    if (relative === 'api' || relative.startsWith('api/')) continue;

    const withoutExtension = stripRouteExtension(relative);
    if (withoutExtension === undefined) continue;

    const baseName = path.posix.basename(withoutExtension);
    const file = toPosix(path.posix.join(args.dir, relative));

    // `_app` wraps every page, which is a layout in everything but name.
    if (baseName === '_app') {
      entries.push(
        specialPagesEntry({ file, kind: 'layout', routePath: '/', id: 'route:layout:/' }),
      );
      continue;
    }
    if (baseName === '_error') {
      entries.push(specialPagesEntry({ file, kind: 'error', routePath: '/', id: 'route:error:/' }));
      continue;
    }
    // `_document` shapes the HTML shell, not a user-visible route.
    if (baseName.startsWith('_')) continue;

    const parsed = parsePagesSegments(withoutExtension);
    if (parsed.isPrivate) continue;

    const appFile = files.find((candidate) => {
      const stripped = stripRouteExtension(candidate);
      return stripped === '_app' || stripped?.endsWith('/_app') === true;
    });

    entries.push({
      id: `route:page:${parsed.path}`,
      source: { file, line: 1 },
      extractionMethod: 'manifest',
      certainty: 'high',
      path: parsed.path,
      kind: 'page',
      params: parsed.params,
      isCatchAll: parsed.isCatchAll,
      component: { file, line: 1 },
      layoutChain:
        appFile === undefined ? [] : [{ file: toPosix(path.posix.join(args.dir, appFile)), line: 1 }],
      guards: guardsFor(parsed.path, args.middleware),
    });
  }

  return { entries, gaps };
}

function specialPagesEntry(args: {
  file: string;
  kind: RouteKind;
  routePath: string;
  id: string;
}): RouteEntry {
  return {
    id: args.id,
    source: { file: args.file, line: 1 },
    extractionMethod: 'manifest',
    certainty: 'high',
    path: args.routePath,
    kind: args.kind,
    params: [],
    isCatchAll: false,
    component: { file: args.file, line: 1 },
    layoutChain: [],
    guards: [],
  };
}
