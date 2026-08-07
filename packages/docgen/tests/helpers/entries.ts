import type { EndpointEntry, HttpMethod, JobEntry, RouteEntry, RouteKind } from '../../src/types/entries.js';

/**
 * Entry builders for chunker tests.
 *
 * These model the shapes the real extractors will emit, so a chunker test that
 * passes here should not need rewriting once the extractors land.
 */

export function route(
  path: string,
  options: {
    kind?: RouteKind;
    file?: string;
    component?: string;
    layoutChain?: readonly string[];
    guards?: readonly { name: string; file: string }[];
    params?: readonly string[];
  } = {},
): RouteEntry {
  const kind = options.kind ?? 'page';
  const file = options.file ?? `app${path === '/' ? '' : path}/${kind}.tsx`;
  return {
    id: `route:${kind}:${path}`,
    source: { file, line: 1 },
    extractionMethod: 'manifest',
    certainty: 'high',
    path,
    kind,
    params: options.params ?? [],
    isCatchAll: false,
    ...(options.component === undefined ? {} : { component: { file: options.component, line: 1 } }),
    layoutChain: (options.layoutChain ?? []).map((f) => ({ file: f, line: 1 })),
    guards: (options.guards ?? []).map((g) => ({ name: g.name, source: { file: g.file, line: 1 } })),
  };
}

export function endpoint(
  method: HttpMethod,
  path: string,
  options: { file?: string; handler?: string } = {},
): EndpointEntry {
  const file = options.file ?? 'src/routes/index.ts';
  return {
    id: `endpoint:${method}:${path}`,
    source: { file, line: 10 },
    extractionMethod: 'ast',
    certainty: 'high',
    method,
    path,
    params: [],
    ...(options.handler === undefined ? {} : { handler: { file: options.handler, line: 20 } }),
    middleware: [],
  };
}

export function job(name: string, options: { file?: string; kind?: JobEntry['kind'] } = {}): JobEntry {
  return {
    id: `job:${name}`,
    source: { file: options.file ?? `src/jobs/${name}.ts`, line: 1 },
    extractionMethod: 'ast',
    certainty: 'high',
    name,
    kind: options.kind ?? 'cron',
  };
}
