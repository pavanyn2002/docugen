import { createHash } from 'node:crypto';
import type { Gap, Skip } from '../../types/core.js';
import type { RouteEntry, RoutesResult } from '../../types/entries.js';
import type { Extractor, ExtractorContext } from '../types.js';
import { inapplicable, skip } from '../types.js';
import { findWorkspaces } from '../../detect/workspaces.js';
import { detectRouters } from './detect.js';
import { extractAppRoutes, extractPagesRoutes } from './next-fs.js';
import { readMiddleware } from './middleware.js';
import { extractReactRouterRoutes } from './react-router.js';
import { compareStrings } from '../../util/sort.js';

/**
 * Every user-facing route in the repo.
 *
 * Detection is per-technology and additive: a repo running both Next routers,
 * or Next alongside a React Router admin bundle, yields all of them. A repo
 * using none is not an error — it returns an inapplicable result with a skip.
 */
export const routesExtractor: Extractor<RouteEntry> = {
  id: 'routes',
  title: 'Routes and screens',

  async run(context: ExtractorContext): Promise<RoutesResult> {
    const startedAt = Date.now();
    const workspaces = await findWorkspaces(context.root, context.config.effectiveExclude);
    const detections = await detectRouters(
      context.root,
      workspaces.map((workspace) => workspace.dir),
    );

    if (detections.length === 0) {
      return inapplicable<RouteEntry>(
        'routes',
        [
          skip(
            'routes',
            'no-router-detected',
            'No Next.js app/pages directory and no react-router dependency were found.',
          ),
        ],
        Date.now() - startedAt,
      );
    }

    const middleware = await readMiddleware(context.root);
    const entries: RouteEntry[] = [];
    const gaps: Gap[] = [...(middleware?.gaps ?? [])];
    const skips: Skip[] = [];
    const detected: string[] = [];

    // An empty `guards` list means "no guard was detected", not "this route is
    // public". Route protection done inside components, in a HOC, or in a data
    // loader is invisible to static analysis. Without this gap a reader would
    // reasonably conclude every route is unauthenticated, which is exactly the
    // kind of confident-and-wrong statement the trust model exists to prevent.
    if (middleware === undefined && detections.some((d) => d.kind !== 'react-router')) {
      gaps.push({
        extractor: 'routes',
        kind: 'no-guard-mechanism-detected',
        message:
          'No Next.js middleware was found, so no route guards could be detected. ' +
          'Auth enforced inside components, HOCs, or data loaders is not visible to static analysis — ' +
          'an empty guard list means undetermined, not public.',
      });
    }

    for (const detection of detections) {
      detected.push(detection.dir === undefined ? detection.kind : `${detection.kind} (${detection.dir})`);

      if (detection.kind === 'next-app' && detection.dir !== undefined) {
        const result = await extractAppRoutes({
          root: context.root,
          dir: detection.dir,
          exclude: context.config.effectiveExclude,
          ...(middleware === undefined ? {} : { middleware }),
        });
        entries.push(...result.entries);
        gaps.push(...result.gaps);
        continue;
      }

      if (detection.kind === 'next-pages' && detection.dir !== undefined) {
        const result = await extractPagesRoutes({
          root: context.root,
          dir: detection.dir,
          exclude: context.config.effectiveExclude,
          ...(middleware === undefined ? {} : { middleware }),
        });
        entries.push(...result.entries);
        gaps.push(...result.gaps);
        continue;
      }

      if (detection.kind === 'react-router') {
        gaps.push({
          extractor: 'routes',
          kind: 'no-guard-mechanism-detected',
          message:
            'React Router guards are ordinary components wrapping an element, which static analysis ' +
            'cannot distinguish from any other wrapper. No route is marked as guarded — an empty ' +
            'guard list means undetermined, not public.',
        });
        const result = await extractReactRouterRoutes({
          root: context.root,
          include: context.config.include,
          exclude: context.config.effectiveExclude,
        });
        entries.push(...result.entries);
        gaps.push(...result.gaps);
        if (result.entries.length === 0) {
          skips.push(
            skip(
              'routes',
              'react-router-no-literal-routes',
              'react-router is a dependency but no statically readable route table was found.',
            ),
          );
        }
      }
    }

    const { deduped, duplicateGaps } = resolveDuplicateIds(entries);

    return {
      extractor: 'routes',
      applicable: true,
      detected: [...detected].sort(),
      entries: sortEntries(deduped),
      gaps: sortGaps([...gaps, ...duplicateGaps]),
      skips,
      durationMs: Date.now() - startedAt,
    };
  },
};

/**
 * Entry ids are derived from kind and path so they survive file moves, which
 * means two files declaring the same route collide. That collision is itself a
 * finding worth reporting — it usually means a genuine duplicate route — so
 * both entries are kept, disambiguated by a hash of their source file.
 */
function resolveDuplicateIds(entries: readonly RouteEntry[]): {
  deduped: readonly RouteEntry[];
  duplicateGaps: readonly Gap[];
} {
  const byId = new Map<string, RouteEntry[]>();
  for (const entry of entries) {
    const bucket = byId.get(entry.id);
    if (bucket === undefined) byId.set(entry.id, [entry]);
    else bucket.push(entry);
  }

  const deduped: RouteEntry[] = [];
  const duplicateGaps: Gap[] = [];

  for (const [id, bucket] of byId) {
    if (bucket.length === 1) {
      deduped.push(bucket[0] as RouteEntry);
      continue;
    }

    const files = bucket.map((entry) => entry.source.file).sort();
    duplicateGaps.push({
      extractor: 'routes',
      kind: 'duplicate-route',
      message:
        `${bucket.length} files declare the same route (${id.replace(/^route:[a-z-]+:/, '')}): ` +
        `${files.join(', ')}. Only one of them can be reachable.`,
      source: { file: files[0] as string },
    });

    for (const entry of bucket) {
      const suffix = createHash('sha256').update(entry.source.file).digest('hex').slice(0, 8);
      deduped.push({ ...entry, id: `${entry.id}#${suffix}` });
    }
  }

  return { deduped, duplicateGaps };
}

/** Deterministic ordering: path, then kind, then id. */
function sortEntries(entries: readonly RouteEntry[]): readonly RouteEntry[] {
  return [...entries].sort(
    (a, b) =>compareStrings(a.path, b.path) ||compareStrings(a.kind, b.kind) ||compareStrings(a.id, b.id),
  );
}

function sortGaps(gaps: readonly Gap[]): readonly Gap[] {
  return [...gaps].sort(
    (a, b) =>compareStrings(a.kind, b.kind) ||compareStrings((a.source?.file ?? ''), b.source?.file ?? '') ||compareStrings(a.message, b.message),
  );
}
