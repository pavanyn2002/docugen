import type { GenerationContext } from '../../types/core.js';
import type { RouteEntry, RoutesResult } from '../../types/entries.js';
import type { StackReport } from '../../detect/stack.js';
import { renderGaps, renderInapplicable, renderProvenance, renderUnsupportedForPage } from '../common.js';
import { certaintyBadge, cell, code, renderFrontMatter, section, sourceLink, table, warning } from '../markdown.js';

/**
 * routes.md — every screen in the product.
 *
 * This page has a specific reader: a QA engineer who has never seen the
 * codebase and needs to list every screen. It therefore leads with the screens
 * themselves, in one flat table, before anything structural.
 */
export function renderRoutesPage(args: {
  result: RoutesResult;
  stack: StackReport;
  context: GenerationContext;
  outDir: string;
}): string {
  const { result, stack, context, outDir } = args;
  const head = renderFrontMatter({ title: 'Routes', confidence: 'verified', context });

  if (!result.applicable) {
    return `${head}# Routes and screens\n\n${renderInapplicable(result, stack)}`;
  }

  const screens = result.entries.filter(
    (entry) => entry.kind === 'page' || entry.kind === 'redirect',
  );
  const supporting = result.entries.filter(
    (entry) => entry.kind !== 'page' && entry.kind !== 'redirect',
  );

  // An empty guard column reads as "this screen is public". It is not: guards
  // enforced inside components are invisible to static analysis, and saying so
  // is the difference between a fact and a dangerous assumption.
  const guardsUndetermined = result.gaps.some((gap) => gap.kind === 'no-guard-mechanism-detected');

  let body = `${head}# Routes and screens\n\n`;
  body += renderProvenance(result);
  body += renderUnsupportedForPage(stack, 'routes', (id) =>
    ['rails', 'laravel', 'spring-boot', 'django', 'fastapi', 'flask'].includes(id),
  );

  if (guardsUndetermined) {
    body += warning([
      'No route guard mechanism was detected in this project, so the **Auth** column is',
      'empty everywhere. That means *undetermined*, not *public* — authentication enforced',
      'inside components, in a HOC, or in a data loader is not visible to static analysis.',
    ]);
  }

  body += section(
    `Screens (${screens.length})`,
    table(
      [
        { header: 'Path', render: (entry: RouteEntry) => code(entry.path) },
        {
          header: 'Auth',
          render: (entry: RouteEntry) =>
            entry.guards.length === 0
              ? guardsUndetermined
                ? '_undetermined_'
                : '—'
              : entry.guards.map((guard) => `\`${guard.name}\``).join(', '),
        },
        {
          header: 'Params',
          render: (entry: RouteEntry) =>
            entry.params.length === 0 ? '—' : entry.params.map((param) => `\`${param}\``).join(', '),
        },
        {
          header: 'Source',
          render: (entry: RouteEntry) =>
            `${sourceLink(entry.component ?? entry.source, outDir)}${certaintyBadge(entry.certainty)}`,
        },
      ],
      screens,
    ),
  );

  if (supporting.length > 0) {
    body += section(
      `Layouts, loading, and error states (${supporting.length})`,
      `These wrap the screens above rather than being screens themselves.\n\n${table(
        [
          { header: 'Kind', render: (entry: RouteEntry) => cell(entry.kind) },
          { header: 'Applies to', render: (entry: RouteEntry) => code(entry.path) },
          { header: 'Source', render: (entry: RouteEntry) => sourceLink(entry.source, outDir) },
        ],
        supporting,
      )}`,
    );
  }

  const layered = screens.filter((entry) => entry.layoutChain.length > 0);
  if (layered.length > 0) {
    body += section(
      'Layout chains',
      table(
        [
          { header: 'Screen', render: (entry: RouteEntry) => code(entry.path) },
          {
            header: 'Wrapped by (outermost first)',
            render: (entry: RouteEntry) =>
              entry.layoutChain.map((ref) => sourceLink(ref, outDir)).join(' → '),
          },
        ],
        layered,
      ),
    );
  }

  body += renderGaps(result.gaps, outDir);
  return body;
}
