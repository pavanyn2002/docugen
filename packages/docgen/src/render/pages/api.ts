import type { GenerationContext } from '../../types/core.js';
import type { EndpointEntry, EndpointsResult } from '../../types/entries.js';
import type { StackReport } from '../../detect/stack.js';
import { renderGaps, renderInapplicable, renderProvenance, renderUnsupportedForPage } from '../common.js';
import { certaintyBadge, code, note, renderFrontMatter, section, sourceLink, table, warning } from '../markdown.js';
import type { Surface } from '../../surface/types.js';
import { workspaceLabel } from '../../detect/ownership.js';

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
  if (!result.applicable) return `${head}# API endpoints\n\n${renderInapplicable(result, stack)}`;

  let body = `${head}# API endpoints\n\n`;
  body += renderProvenance(result);
  body += renderUnsupportedForPage(stack, 'endpoints', (id) =>
    ['fastify', 'medusa', 'fastapi', 'flask', 'rails', 'laravel', 'spring-boot'].includes(id));

  const specChecked = result.detected.includes('openapi-spec');
  if (specChecked && result.openapi !== undefined) {
    const summary = result.openapi;
    body += section('OpenAPI comparison', table(
      [
        { header: 'Result', render: (row: { label: string; count: number }) => row.label },
        { header: 'Count', render: (row: { label: string; count: number }) => String(row.count) },
      ],
      [
        { label: 'Operations compared in an applicable runtime', count: summary.operationsCompared },
        { label: 'Code endpoints absent from the applicable spec', count: summary.codeEndpointsAbsent },
        { label: 'Spec operations without handlers', count: summary.specOperationsWithoutHandlers },
        { label: 'Operations skipped because scope was ambiguous', count: summary.operationsSkippedAmbiguous },
        { label: 'Distinct ambiguous source documents', count: summary.ambiguousDocuments },
      ],
    ));
    if (summary.operationsSkippedAmbiguous > 0) {
      body += warning([
        'The API specification was **partially cross-checked**. Ambiguous operations were left unannotated;',
        'docgen did not compare them globally or assign them to a guessed application.',
      ]);
    } else if (summary.codeEndpointsAbsent > 0 || summary.specOperationsWithoutHandlers > 0) {
      body += warning([
        'The applicable API documents were cross-checked against their runtime applications. The code is what runs;',
        'the specification is not treated as authoritative. See the findings below for disagreements.',
      ]);
    }
  }

  const columns = [
    ...(result.entries.some((entry) => entry.workspace !== undefined)
      ? [{ header: 'Workspace', render: (entry: EndpointEntry) => code(workspaceLabel(entry.workspace ?? '')) }]
      : []),
    ...(new Set(result.entries.map((entry) => entry.application).filter(Boolean)).size > 1
      ? [{ header: 'Application', render: (entry: EndpointEntry) => code(applicationLabel(entry)) }]
      : []),
    { header: 'Method', render: (entry: EndpointEntry) => `\`${entry.method}\`` },
    { header: 'Path', render: (entry: EndpointEntry) => code(entry.path) },
    {
      header: 'Middleware',
      render: (entry: EndpointEntry) => entry.middleware.length === 0
        ? '—'
        : entry.middleware.map((name) => `\`${name}\``).join(', '),
    },
    {
      header: 'Request',
      render: (entry: EndpointEntry) => entry.requestShape === undefined ? '—' : code(entry.requestShape.name),
    },
    ...(specChecked ? [{
      header: 'In spec',
      render: (entry: EndpointEntry) =>
        entry.specStatus === 'match' ? 'yes' : entry.specStatus === undefined ? '—' : '**no**',
    }] : []),
    {
      header: 'Source',
      render: (entry: EndpointEntry) =>
        `${sourceLink(entry.handler ?? entry.source, outDir)}${certaintyBadge(entry.certainty)}`,
    },
  ];

  const byId = new Map(result.entries.map((entry) => [entry.id, entry]));
  const grouped = new Set<string>();
  const endpointSurfaces = args.surfaces.filter((surface) => surface.endpoints.length > 0);
  if (args.surfaceNotes.length > 0) body += note(args.surfaceNotes);
  body += section(`Endpoints (${result.entries.length})`, '');
  for (const surface of endpointSurfaces) {
    const rows = surface.endpoints.map((id) => byId.get(id))
      .filter((entry): entry is EndpointEntry => entry !== undefined);
    if (rows.length === 0) continue;
    for (const row of rows) grouped.add(row.id);
    body += section(surface.title, table(columns, rows), 3);
  }
  const ungrouped = result.entries.filter((entry) => !grouped.has(entry.id));
  if (ungrouped.length > 0) body += section('Other', table(columns, ungrouped), 3);
  body += renderGaps(result.gaps, outDir);
  return body;
}

function applicationLabel(entry: EndpointEntry): string {
  if (entry.application === undefined) return 'unresolved router';
  const [, kind = 'application', ...root] = entry.application.split(':');
  return `${kind} · ${root.join(':')}`;
}
