import { colors } from '../util/colors.js';
import { loadConfig } from '../config/load.js';
import { runExtraction } from '../pipeline.js';
import type { Logger } from '../util/logger.js';

export interface ReportCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  readonly json: boolean;
  readonly logger: Logger;
}

/**
 * `docgen report` — coverage summary and gap lists (SPEC 6.4).
 *
 * The four gap analyses (dead routes, orphan components, unreferenced tables,
 * undeclared/unread env vars) are cross-extractor, so they are implemented once
 * the extractors they compare exist. Until then this reports coverage only, and
 * says plainly which analyses are missing rather than printing an empty list
 * that would read as "no problems found".
 */
export async function runReportCommand(options: ReportCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });

  const result = await runExtraction({ config, logger: options.logger });

  const totals = [...result.results.values()].reduce(
    (acc, value) => ({
      entries: acc.entries + value.entries.length,
      gaps: acc.gaps + value.gaps.length,
    }),
    { entries: 0, gaps: 0 },
  );

  if (options.json) {
    options.logger.output(
      JSON.stringify(
        {
          engineVersion: result.context.engineVersion,
          totals,
          unimplemented: [...result.unimplemented],
          gapAnalyses: { available: [], pending: PENDING_ANALYSES },
        },
        null,
        2,
      ),
    );
    return;
  }

  options.logger.heading('docgen report');
  options.logger.info(`  entries   ${totals.entries}`);
  options.logger.info(`  gaps      ${totals.gaps}`);

  options.logger.heading('Gap analyses');
  for (const analysis of PENDING_ANALYSES) {
    options.logger.info(`  ${colors().dim('pending')}  ${analysis}`);
  }
  options.logger.warn(
    'No gap analysis has run. An empty result here does not mean the repo is clean — ' +
      'it means the extractors these analyses compare are not built yet.',
  );
}

const PENDING_ANALYSES: readonly string[] = Object.freeze([
  'routes with no matching component file (dead routes)',
  'components not reachable from any route (orphans)',
  'tables not referenced anywhere in code',
  'env vars declared but never read',
  'env vars read but never declared',
]);
