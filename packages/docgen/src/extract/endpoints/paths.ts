/** Shared path helpers for endpoint extraction. */

/** Join a mount prefix with a route path, collapsing slashes. */
export function joinPath(prefix: string, routePath: string): string {
  const combined = `/${prefix}/${routePath}`.replace(/\/+/g, '/');
  return combined.length > 1 ? combined.replace(/\/$/, '') : '/';
}

/** Dynamic segment names in `:id`, `[id]`, and `{id}` syntax. */
export function paramsOf(routePath: string): readonly string[] {
  return routePath
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) return segment.slice(1).replace(/[?*+]$/, '');
      const bracket = /^\[\.{0,3}(.+)\]$/.exec(segment);
      if (bracket?.[1] !== undefined) return bracket[1];
      const brace = /^\{(.+)\}$/.exec(segment);
      if (brace?.[1] !== undefined) return brace[1];
      return undefined;
    })
    .filter((name): name is string => name !== undefined && name.length > 0);
}
