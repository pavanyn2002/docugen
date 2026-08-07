import type { GenerationContext } from '../../types/core.js';
import type { EndpointEntry, EndpointsResult } from '../../types/entries.js';
import type { StackReport } from '../../detect/stack.js';
import { renderGaps, renderInapplicable, renderProvenance, renderUnsupportedForPage } from '../common.js';
import { certaintyBadge, code, note, renderFrontMatter, section, sourceLink, table, warning } from '../markdown.js';
import type { Surface } from '../../surface/types.js';

/** api.md — every endpoint the service serves, grouped by resource. */
export function renderApiPage(args: {
  result: EndpointsResult;
  stack: StackReport;
  context: GenerationContext;
  outDir: string;
  surfaces: readonly Surface[];
  surfaceNotes: readonly string[];
}): string {
  const { result, stack, context, outDir } = args;
  const head = renderFrontMatter({ title: 'API', confidence: 'verified', context });

  if (!result.applicable) {
    return `${head}# API endpoints\n\n${renderInapplicable(result, stack)}`;
  }

  let body = `${head}# API endpoints\n\n`;
  body += renderProvenance(result);
  body += renderUnsupportedForPage(stack, 'endpoints', (id) =>
    ['fastify', 'medusa', 'fastapi', 'flask', 'rails', 'laravel', 'spring-boot'].includes(id),
  );

  const specChecked = result.detected.includes('openapi-spec');
  if (specChecked) {
    const undeclared = result.entries.filter((entry) => entry.specStatus === 'undeclared').length;
    const phantom = result.gaps.some((gap) => gap.kind === 'spec-endpoint-not-in-code');

    if (undeclared > 0 || phantom) {
      // The spec is a claim about the code, and this is where it disagrees.
      body += warning([
        'An API spec was found and **cross-checked against the code**. The code is what runs;',
        'the spec is not treated as authoritative.',
        '',
        ...(undeclared > 0 ? [`- ${undeclared} endpoint(s) below exist in code but are absent from the spec.`] : []),
        ...(phantom ? ['- The spec declares endpoints with no handler behind them — see the table at the end.'] : []),
        '',
        'Anyone working from the spec alone is working from something that disagrees with the service.',
      ]);
    }
  }

  const columns = [
    { header: 'Method', render: (entry: EndpointEntry) => `\`${entry.method}\`` },
    { header: 'Path', render: (entry: EndpointEntry) => code(entry.path) },
    {
      header: 'Middleware',
      render: (entry: EndpointEntry) =>
        entry.middleware.length === 0
          ? '—'
          : entry.middleware.map((name) => `\`${name}\``).join(', '),
    },
    {
      header: 'Request',
      render: (entry: EndpointEntry) => (entry.requestShape === undefined ? '—' : code(entry.requestShape.name)),
    },
    ...(specChecked
      ? [
          {
            header: 'In spec',
            render: (entry: EndpointEntry) =>
              entry.specStatus === 'match' ? 'yes' : entry.specStatus === undefined ? '—' : '**no**',
          },
        ]
      : []),
    {
      header: 'Source',
      render: (entry: EndpointEntry) =>
        `${sourceLink(entry.handler ?? entry.source, outDir)}${certaintyBadge(entry.certainty)}`,
    },
  ];

  // Grouped by surface — the unit someone asks a question about ("the enquiry
  // API"), not one verb in isolation. The chunker also strips a mount prefix
  // shared by every endpoint, so a microservice does not collapse into one
  // group named after itself.
  const byId = new Map(result.entries.map((entry) => [entry.id, entry]));
  const grouped = new Set<string>();

  const endpointSurfaces = args.surfaces.filter((surface) => surface.endpoints.length > 0);
  if (args.surfaceNotes.length > 0) {
    body += note(args.surfaceNotes);
  }

  body += section(`Endpoints (${result.entries.length})`, '');

  for (const surface of endpointSurfaces) {
    const rows = surface.endpoints
      .map((id) => byId.get(id))
      .filter((entry): entry is EndpointEntry => entry !== undefined);
    if (rows.length === 0) continue;
    for (const row of rows) grouped.add(row.id);
    body += section(surface.title, table(columns, rows), 3);
  }

  // Anything the chunker did not place still has to appear; silently dropping
  // an endpoint from the docs is worse than an untidy heading.
  const ungrouped = result.entries.filter((entry) => !grouped.has(entry.id));
  if (ungrouped.length > 0) {
    body += section('Other', table(columns, ungrouped), 3);
  }

  body += renderGaps(result.gaps, outDir);
  return body;
}
