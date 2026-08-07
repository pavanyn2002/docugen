import picomatch from 'picomatch';
import type { Gap } from '../types/core.js';
import type { EndpointEntry, JobEntry, RouteEntry } from '../types/entries.js';
import { DocgenError } from '../util/errors.js';
import { detectServicePrefix, endpointGroupKey, normalisePath } from './group.js';
import { assignSlugs } from './slug.js';
import type { Surface, SurfaceKind, SurfaceSet, UnassignedEntry } from './types.js';

/** Route kinds that are a screen in their own right, versus ones that support screens. */
const SCREEN_ROUTE_KINDS = new Set(['page', 'redirect']);

export interface ChunkInput {
  readonly routes: readonly RouteEntry[];
  readonly endpoints: readonly EndpointEntry[];
  readonly jobs: readonly JobEntry[];
  readonly overrides?: readonly {
    readonly id: string;
    readonly kind: SurfaceKind;
    readonly title?: string;
    readonly include: readonly string[];
  }[];
  readonly apiBasePaths?: readonly string[];
}

// ── source file collection ───────────────────────────────────────────────────

function filesOfRoute(route: RouteEntry): string[] {
  return [
    route.source.file,
    route.component?.file,
    ...route.layoutChain.map((ref) => ref.file),
    ...route.guards.map((guard) => guard.source.file),
  ].filter((file): file is string => file !== undefined);
}

function filesOfEndpoint(endpoint: EndpointEntry): string[] {
  return [
    endpoint.source.file,
    endpoint.handler?.file,
    endpoint.requestShape?.source?.file,
    endpoint.responseShape?.source?.file,
  ].filter((file): file is string => file !== undefined);
}

function filesOfJob(job: JobEntry): string[] {
  return [job.source.file, job.handler?.file].filter((file): file is string => file !== undefined);
}

// ── override matching ────────────────────────────────────────────────────────

interface OverrideMatcher {
  readonly id: string;
  readonly kind: SurfaceKind;
  readonly title?: string;
  readonly matches: (file: string) => boolean;
}

function buildOverrideMatchers(input: ChunkInput): readonly OverrideMatcher[] {
  return (input.overrides ?? []).map((override) => {
    const isMatch = picomatch([...override.include], { dot: true });
    return {
      id: override.id,
      kind: override.kind,
      ...(override.title === undefined ? {} : { title: override.title }),
      matches: (file: string) => isMatch(file),
    };
  });
}

/**
 * Find the override owning an entry, by its own source file.
 *
 * A file matching two overrides is a config error rather than a first-wins
 * coin-flip: ambiguous config produces ambiguous documentation, and the user is
 * the only one who can say which surface they meant.
 */
function resolveOverride(
  file: string,
  matchers: readonly OverrideMatcher[],
): OverrideMatcher | undefined {
  const hits = matchers.filter((matcher) => matcher.matches(file));
  if (hits.length > 1) {
    throw new DocgenError({
      code: 'surface-override-ambiguous',
      message: `${file} matches ${hits.length} surface overrides: ${hits.map((h) => h.id).join(', ')}.`,
      remedy: 'Narrow the `include` globs in surfaces.overrides so each file belongs to exactly one surface.',
      file,
    });
  }
  return hits[0];
}

// ── surface assembly ─────────────────────────────────────────────────────────

/** Mutable accumulator; frozen into a Surface at the end. */
interface Draft {
  id: string;
  kind: SurfaceKind;
  title: string;
  origin: 'derived' | 'override';
  routes: Set<string>;
  supportingRoutes: Set<string>;
  endpoints: Set<string>;
  jobs: Set<string>;
  files: Set<string>;
}

function draftFor(
  drafts: Map<string, Draft>,
  id: string,
  init: Pick<Draft, 'kind' | 'title' | 'origin'>,
): Draft {
  const existing = drafts.get(id);
  if (existing !== undefined) return existing;
  const created: Draft = {
    id,
    ...init,
    routes: new Set(),
    supportingRoutes: new Set(),
    endpoints: new Set(),
    jobs: new Set(),
    files: new Set(),
  };
  drafts.set(id, created);
  return created;
}

function draftForOverride(
  drafts: Map<string, Draft>,
  override: OverrideMatcher,
  used: Set<string>,
): Draft {
  used.add(override.id);
  return draftFor(drafts, override.id, {
    kind: override.kind,
    title: override.title ?? override.id,
    origin: 'override',
  });
}

/**
 * Chunk extracted entries into surfaces.
 *
 * Pure and deterministic: the same entries always produce byte-identical
 * output, including ordering. Nothing is dropped — every entry lands in a
 * surface or in `unassigned` with a reason.
 */
export function chunkSurfaces(input: ChunkInput): SurfaceSet {
  const matchers = buildOverrideMatchers(input);
  const drafts = new Map<string, Draft>();
  const unassigned: UnassignedEntry[] = [];
  const gaps: Gap[] = [];
  const notes: string[] = [];
  const usedOverrideIds = new Set<string>();

  // Screens, and the supporting routes that will attach to them.
  const screenRoutes: RouteEntry[] = [];
  const supportingRoutes: RouteEntry[] = [];

  for (const route of input.routes) {
    const override = resolveOverride(route.source.file, matchers);
    if (override !== undefined) {
      const draft = draftForOverride(drafts, override, usedOverrideIds);
      const bucket = SCREEN_ROUTE_KINDS.has(route.kind) ? draft.routes : draft.supportingRoutes;
      bucket.add(route.id);
      for (const file of filesOfRoute(route)) draft.files.add(file);
      continue;
    }

    if (SCREEN_ROUTE_KINDS.has(route.kind)) screenRoutes.push(route);
    else supportingRoutes.push(route);
  }

  for (const route of screenRoutes) {
    const path = normalisePath(route.path);
    // Title is the path verbatim. Anything more interpretive would be a
    // behavioural claim, and those belong to Phase 1 with a badge.
    const draft = draftFor(drafts, `screen:${path}`, {
      kind: 'screen',
      title: path,
      origin: 'derived',
    });
    draft.routes.add(route.id);
    for (const file of filesOfRoute(route)) draft.files.add(file);
  }

  attachSupportingRoutes({ supportingRoutes, screenRoutes, drafts, unassigned });

  // Computed once over the whole endpoint set: whether a shared mount prefix
  // should be stripped is a property of the set, not of any single path.
  const servicePrefix = detectServicePrefix(
    input.endpoints.map((entry) => entry.path),
    input.apiBasePaths ?? [],
  );
  if (servicePrefix !== undefined) {
    notes.push(
      `All API endpoints share the mount prefix '/${servicePrefix}'. It was stripped before grouping, ` +
        'so endpoint surfaces are named after the resource beneath it.',
    );
  }

  for (const endpoint of input.endpoints) {
    const override = resolveOverride(endpoint.source.file, matchers);
    const groupKey = endpointGroupKey(endpoint.path, input.apiBasePaths ?? [], servicePrefix);
    const draft =
      override !== undefined
        ? draftForOverride(drafts, override, usedOverrideIds)
        : draftFor(drafts, `api:${groupKey}`, {
            kind: 'endpoint-group',
            title: groupKey,
            origin: 'derived',
          });
    draft.endpoints.add(endpoint.id);
    for (const file of filesOfEndpoint(endpoint)) draft.files.add(file);
  }

  for (const job of input.jobs) {
    const override = resolveOverride(job.source.file, matchers);
    const draft =
      override !== undefined
        ? draftForOverride(drafts, override, usedOverrideIds)
        : draftFor(drafts, `job:${job.name}`, { kind: 'job', title: job.name, origin: 'derived' });
    draft.jobs.add(job.id);
    for (const file of filesOfJob(job)) draft.files.add(file);
  }

  // An override that matched nothing is almost always a stale or typo'd glob.
  // Reported rather than ignored, because a silently inert override means the
  // user believes a surface exists that does not.
  for (const matcher of matchers) {
    if (!usedOverrideIds.has(matcher.id)) {
      gaps.push({
        extractor: 'surface',
        kind: 'override-matched-nothing',
        message: `Surface override '${matcher.id}' matched no extracted entry. Its include globs may be stale.`,
      });
    }
  }

  return finalise(drafts, unassigned, gaps, notes);
}

/**
 * Attach layouts, templates, and error boundaries to the screens they wrap.
 *
 * Two signals are used: the framework's own layout chain when the routes
 * extractor resolved one, and path containment, which is how segment-scoped
 * files behave in every file-system router. A supporting route matching neither
 * is genuinely orphaned — that is real signal for `docgen report`, not noise.
 */
function attachSupportingRoutes(args: {
  supportingRoutes: readonly RouteEntry[];
  screenRoutes: readonly RouteEntry[];
  drafts: Map<string, Draft>;
  unassigned: UnassignedEntry[];
}): void {
  for (const supporting of args.supportingRoutes) {
    const supportingPath = normalisePath(supporting.path);
    const prefix = supportingPath === '/' ? '/' : `${supportingPath}/`;

    const targets = args.screenRoutes.filter((screen) => {
      const screenPath = normalisePath(screen.path);
      if (screenPath === supportingPath || screenPath.startsWith(prefix)) return true;
      return screen.layoutChain.some((ref) => ref.file === supporting.source.file);
    });

    if (targets.length === 0) {
      args.unassigned.push({
        entryId: supporting.id,
        extractor: 'routes',
        reason: 'supporting-route-unattached',
        detail:
          `${supporting.kind} at ${supportingPath} (${supporting.source.file}) wraps no screen. ` +
          'It may be dead code, or the routes extractor may have failed to resolve its segment.',
      });
      continue;
    }

    for (const target of targets) {
      const draft = args.drafts.get(`screen:${normalisePath(target.path)}`);
      if (draft === undefined) continue;
      draft.supportingRoutes.add(supporting.id);
      for (const file of filesOfRoute(supporting)) draft.files.add(file);
    }
  }
}

/** Sort rank for surface kinds, so screens lead the generated docs. */
const KIND_RANK: Readonly<Record<SurfaceKind, number>> = Object.freeze({
  screen: 0,
  'endpoint-group': 1,
  job: 2,
});

function finalise(
  drafts: ReadonlyMap<string, Draft>,
  unassigned: readonly UnassignedEntry[],
  gaps: readonly Gap[],
  notes: readonly string[],
): SurfaceSet {
  const ordered = [...drafts.values()].sort(
    (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.id.localeCompare(b.id),
  );
  const slugs = assignSlugs(ordered.map((draft) => draft.id));

  const surfaces: Surface[] = ordered.map((draft) => ({
    id: draft.id,
    slug: slugs.get(draft.id) as string,
    kind: draft.kind,
    title: draft.title,
    routes: [...draft.routes].sort(),
    supportingRoutes: [...draft.supportingRoutes].sort(),
    endpoints: [...draft.endpoints].sort(),
    jobs: [...draft.jobs].sort(),
    sourceFiles: [...draft.files].sort(),
    origin: draft.origin,
  }));

  return {
    surfaces,
    unassigned: [...unassigned].sort((a, b) => a.entryId.localeCompare(b.entryId)),
    gaps: [...gaps].sort((a, b) => a.kind.localeCompare(b.kind) || a.message.localeCompare(b.message)),
    notes: [...notes].sort(),
  };
}
