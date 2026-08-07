/**
 * Next.js file-system route segment parsing.
 *
 * This is the correctness core of the routes extractor: a directory path maps
 * to a public URL through a set of conventions, several of which remove
 * segments from the URL entirely. Getting a segment wrong means documenting a
 * URL that does not exist, so each convention is handled explicitly and
 * anything unrecognised is reported rather than guessed at.
 */

export interface ParsedSegments {
  /** Public URL path with framework syntax preserved, e.g. '/orders/[id]'. */
  readonly path: string;
  /** Dynamic parameter names in order. */
  readonly params: readonly string[];
  readonly isCatchAll: boolean;
  /** True for `[[...slug]]`, which also matches the parent path. */
  readonly isOptionalCatchAll: boolean;
  /** Route group names, e.g. `(marketing)`. Removed from the URL. */
  readonly groups: readonly string[];
  /** Parallel route slot names, e.g. `@modal`. Removed from the URL. */
  readonly slots: readonly string[];
  /** True when any segment is an intercepting route, e.g. `(.)photo`. */
  readonly isIntercepting: boolean;
  /** True when any segment is a `_private` folder, making this not routable. */
  readonly isPrivate: boolean;
}

const OPTIONAL_CATCH_ALL = /^\[\[\.\.\.(.+)\]\]$/;
const CATCH_ALL = /^\[\.\.\.(.+)\]$/;
const DYNAMIC = /^\[(.+)\]$/;
const ROUTE_GROUP = /^\((?!\.)(.*)\)$/;
const INTERCEPTING = /^\(\.{1,3}\)(.+)$/;

/**
 * Parse an app-router directory path (relative to `app/`) into a URL.
 *
 * Pass '' for the app root itself.
 */
export function parseAppSegments(relativeDir: string): ParsedSegments {
  const raw = relativeDir.split('/').filter((segment) => segment.length > 0);

  const urlSegments: string[] = [];
  const params: string[] = [];
  const groups: string[] = [];
  const slots: string[] = [];
  let isCatchAll = false;
  let isOptionalCatchAll = false;
  let isIntercepting = false;
  let isPrivate = false;

  for (const segment of raw) {
    // A `_folder` opts the whole subtree out of routing.
    if (segment.startsWith('_')) {
      isPrivate = true;
      continue;
    }

    // `@modal` is a parallel slot: it names a slot in the parent layout and
    // contributes nothing to the URL.
    if (segment.startsWith('@')) {
      slots.push(segment.slice(1));
      continue;
    }

    const group = ROUTE_GROUP.exec(segment);
    if (group !== null) {
      groups.push(group[1] as string);
      continue;
    }

    const intercept = INTERCEPTING.exec(segment);
    if (intercept !== null) {
      isIntercepting = true;
      urlSegments.push(intercept[1] as string);
      continue;
    }

    const optionalCatchAll = OPTIONAL_CATCH_ALL.exec(segment);
    if (optionalCatchAll !== null) {
      params.push(optionalCatchAll[1] as string);
      isCatchAll = true;
      isOptionalCatchAll = true;
      urlSegments.push(segment);
      continue;
    }

    const catchAll = CATCH_ALL.exec(segment);
    if (catchAll !== null) {
      params.push(catchAll[1] as string);
      isCatchAll = true;
      urlSegments.push(segment);
      continue;
    }

    const dynamic = DYNAMIC.exec(segment);
    if (dynamic !== null) {
      params.push(dynamic[1] as string);
      urlSegments.push(segment);
      continue;
    }

    urlSegments.push(segment);
  }

  return {
    path: urlSegments.length === 0 ? '/' : `/${urlSegments.join('/')}`,
    params,
    isCatchAll,
    isOptionalCatchAll,
    groups,
    slots,
    isIntercepting,
    isPrivate,
  };
}

/**
 * Parse a pages-router file path (relative to `pages/`, extension removed).
 *
 * `index` collapses into its parent directory, which is the one rule that
 * differs from the app router.
 */
export function parsePagesSegments(relativeFileWithoutExtension: string): ParsedSegments {
  const raw = relativeFileWithoutExtension.split('/').filter((segment) => segment.length > 0);
  const trimmed = raw[raw.length - 1] === 'index' ? raw.slice(0, -1) : raw;
  return parseAppSegments(trimmed.join('/'));
}

/** Strip a known route file extension, or return undefined if there is none. */
export function stripRouteExtension(fileName: string): string | undefined {
  const match = /^(.*)\.(tsx|ts|jsx|js|mjs|mdx)$/.exec(fileName);
  return match?.[1];
}
