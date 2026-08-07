import type {
  ConfigResult,
  EndpointsResult,
  JobsResult,
  RoutesResult,
  SchemaResult,
} from '../types/entries.js';
import type { Surface } from '../surface/types.js';

/**
 * The verified facts handed to the model alongside the code.
 *
 * These come from the static lane, so they are already true. Passing them in
 * does two jobs: it stops the model spending effort re-deriving what a parser
 * already established, and it gives it a frame it must not contradict — an
 * inferred claim that disagrees with an extracted fact is the clearest possible
 * signal that the model is guessing.
 */
export interface ExtractionBundleLike {
  readonly routes?: RoutesResult | undefined;
  readonly endpoints?: EndpointsResult | undefined;
  readonly schema?: SchemaResult | undefined;
  readonly jobs?: JobsResult | undefined;
  readonly config?: ConfigResult | undefined;
}

export function renderFacts(surface: Surface, bundle: ExtractionBundleLike): string {
  const lines: string[] = [`- Surface: **${surface.title}** (${surface.kind})`];

  const routeIds = new Set([...surface.routes, ...surface.supportingRoutes]);
  const routes = (bundle.routes?.entries ?? []).filter((entry) => routeIds.has(entry.id));
  for (const route of routes) {
    const guards =
      route.guards.length === 0
        ? 'no guard detected (this does NOT mean it is public)'
        : `guards: ${route.guards.map((guard) => guard.name).join(', ')}`;
    lines.push(`- Route \`${route.path}\` (${route.kind}) — ${guards} — ${route.source.file}`);
  }

  const endpointIds = new Set(surface.endpoints);
  for (const endpoint of (bundle.endpoints?.entries ?? []).filter((entry) => endpointIds.has(entry.id))) {
    const middleware =
      endpoint.middleware.length === 0 ? 'no middleware' : `middleware: ${endpoint.middleware.join(', ')}`;
    const shape = endpoint.requestShape === undefined ? '' : `, validates against ${endpoint.requestShape.name}`;
    lines.push(
      `- \`${endpoint.method} ${endpoint.path}\` — ${middleware}${shape} — ${endpoint.source.file}`,
    );
  }

  const jobIds = new Set(surface.jobs);
  for (const job of (bundle.jobs?.entries ?? []).filter((entry) => jobIds.has(entry.id))) {
    const trigger =
      job.schedule !== undefined
        ? `schedule ${job.schedule}`
        : job.channel !== undefined
          ? `on message to ${job.channel}`
          : 'trigger not determined';
    lines.push(`- Job \`${job.name}\` (${job.kind}) — ${trigger} — ${job.source.file}`);
  }

  // Tables the surface's files touch, so the model can describe what is
  // persisted without inventing a schema.
  const surfaceFiles = new Set(surface.sourceFiles);
  const tables = (bundle.schema?.entries ?? []).filter((entry) => surfaceFiles.has(entry.source.file));
  for (const table of tables) {
    lines.push(
      `- Table \`${table.name}\` with fields: ${table.fields
        .slice(0, 25)
        .map((field) => field.name)
        .join(', ')}${table.fields.length > 25 ? ', …' : ''}`,
    );
  }

  const envNames = (bundle.config?.entries ?? [])
    .filter((entry) => entry.reads.some((ref) => surfaceFiles.has(ref.file)))
    .map((entry) => entry.name);
  if (envNames.length > 0) {
    lines.push(`- Reads environment variables: ${envNames.join(', ')}`);
  }

  return lines.join('\n');
}
