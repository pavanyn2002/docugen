/**
 * Endpoint grouping.
 *
 * One endpoint is too fine a surface — QA asks about "the enquiry API", not
 * about `POST /projects/enquiry/:id/store` in isolation. Endpoints are
 * therefore grouped by their resource segment.
 *
 * Grouping is driven by the path rather than by the handler's module, even
 * though the module is often the truer authorial unit. The path is always
 * present; the handler file is frequently unresolvable and would be recorded as
 * a gap. Mixing the two rules would make group membership shift as parsers
 * improve, and surface ids must stay stable — Phase 1 files answers under them.
 */

/** Collapse repeated slashes, force a leading slash, drop any trailing slash. */
export function normalisePath(path: string): string {
  const collapsed = `/${path}`.replace(/\/+/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : '/';
}

/** True for `:id`, `[id]`, `{id}`, `*`, and `...rest` style segments. */
export function isDynamicSegment(segment: string): boolean {
  return (
    segment.startsWith(':') ||
    segment.startsWith('[') ||
    segment.startsWith('{') ||
    segment.startsWith('*') ||
    segment.startsWith('...')
  );
}

/** Segments stripped before grouping: an `api` prefix and any `v1`-style version. */
function isBoilerplateSegment(segment: string): boolean {
  return segment === 'api' || /^v\d+$/.test(segment);
}

/** Path segments remaining after configured base paths and `api`/`vN` are removed. */
export function residualSegments(path: string, apiBasePaths: readonly string[] = []): readonly string[] {
  let remaining = normalisePath(path);

  // Longest base first, so '/api/internal' wins over '/api' when both are configured.
  for (const base of [...apiBasePaths].sort((a, b) => b.length - a.length)) {
    const normalisedBase = normalisePath(base);
    if (normalisedBase === '/') continue;
    if (remaining === normalisedBase) {
      remaining = '/';
      break;
    }
    if (remaining.startsWith(`${normalisedBase}/`)) {
      remaining = remaining.slice(normalisedBase.length);
      break;
    }
  }

  const segments = remaining.split('/').filter((segment) => segment.length > 0);
  while (segments.length > 0 && isBoilerplateSegment(segments[0] as string)) {
    segments.shift();
  }
  return segments;
}

/** The group name for a set of residual segments. */
function groupKeyOf(segments: readonly string[]): string {
  const first = segments[0];
  // A path with no leading static segment has no resource name to group under.
  if (first === undefined || isDynamicSegment(first)) return '(root)';
  return first;
}

/**
 * Detect a service-wide mount prefix shared by every endpoint.
 *
 * Microservices routinely mount their entire router under their own name
 * (`app.use('/projects', projectRoutes)`), which would otherwise collapse the
 * whole service into a single surface named after the mount point — precisely
 * the granularity the surface concept exists to avoid.
 *
 * The prefix is only stripped when doing so actually increases granularity. A
 * service genuinely built around one resource (`/orders`, `/orders/:id`) keeps
 * its name, because stripping would yield one anonymous `(root)` group, which
 * is strictly worse.
 *
 * Returns the segment to strip, or undefined to leave paths alone.
 */
export function detectServicePrefix(
  paths: readonly string[],
  apiBasePaths: readonly string[] = [],
): string | undefined {
  if (paths.length < 2) return undefined;

  const residuals = paths.map((path) => residualSegments(path, apiBasePaths));
  const candidate = residuals[0]?.[0];
  if (candidate === undefined || isDynamicSegment(candidate)) return undefined;
  if (!residuals.every((segments) => segments[0] === candidate)) return undefined;

  const groupsAfterStripping = new Set(residuals.map((segments) => groupKeyOf(segments.slice(1))));
  return groupsAfterStripping.size > 1 ? candidate : undefined;
}

/**
 * The resource key an endpoint path belongs to.
 *
 * `/api/v1/orders/:id/items` → `orders`. Sub-resources join their parent rather
 * than forming their own surface; splitting them produces a long tail of
 * one-endpoint surfaces that nobody asks questions about at that granularity.
 * Repos that need a different split use `surfaces.overrides`.
 */
export function endpointGroupKey(
  path: string,
  apiBasePaths: readonly string[] = [],
  servicePrefix?: string,
): string {
  const segments = residualSegments(path, apiBasePaths);
  if (servicePrefix !== undefined && segments[0] === servicePrefix) {
    return groupKeyOf(segments.slice(1));
  }
  return groupKeyOf(segments);
}
