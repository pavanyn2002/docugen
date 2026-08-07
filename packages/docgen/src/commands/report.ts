import { colors } from '../util/colors.js';
import { loadConfig } from '../config/load.js';
import { runExtraction } from '../pipeline.js';
import { computeFindings, sortItems } from '../analysis/findings.js';
import { EXTRACTOR_IDS } from '../types/core.js';
import type { Logger } from '../util/logger.js';

export interface ReportCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  readonly json: boolean;
  /** Show every item rather than the first few of each finding. */
  readonly full?: boolean;
  readonly logger: Logger;
}

/** How many items of each finding to print before summarising the rest. */
const PREVIEW_LIMIT = 10;

/**
 * `docgen report` — coverage, and the cross-extractor findings (SPEC 6.4).
 *
 * Exits 0 whether or not it finds anything. Findings are observations for a
 * human to judge, not failures: `docgen check` is the gate that fails a build,
 * and conflating the two would train people to ignore both.
 */
export async function runReportCommand(options: ReportCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });

  const result = await runExtraction({ config, logger: options.logger });
  const findings = await computeFindings(result);

  if (options.json) {
    options.logger.output(
      JSON.stringify(
        {
          engineVersion: result.context.engineVersion,
          sourceCommit: result.context.sourceCommit ?? null,
          coverage: EXTRACTOR_IDS.map((id) => {
            const extractor = result.results.get(id);
            return {
              extractor: id,
              applicable: extractor?.applicable ?? false,
              entries: extractor?.entries.length ?? 0,
              gaps: extractor?.gaps.length ?? 0,
              detected: [...(extractor?.detected ?? [])],
            };
          }),
          unsupported: result.stack.unsupported.map((tech) => ({
            id: tech.id,
            name: tech.name,
            evidence: tech.evidence.file,
            note: tech.unsupportedNote ?? null,
          })),
          findings: findings.findings.map((finding) => ({
            id: finding.id,
            title: finding.title,
            unavailable: finding.unavailable ?? null,
            count: finding.items.length,
            items: sortItems(finding.items).map((item) => ({
              label: item.label,
              detail: item.detail ?? null,
              file: item.source?.file ?? null,
              line: item.source?.line ?? null,
            })),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  renderCoverage(result, options.logger);
  renderFindings(findings, options.full === true, options.logger);
}

function renderCoverage(
  result: Awaited<ReturnType<typeof runExtraction>>,
  logger: Logger,
): void {
  logger.heading('Coverage');
  for (const id of EXTRACTOR_IDS) {
    const extractor = result.results.get(id);
    if (extractor === undefined) {
      logger.info(`  ${id.padEnd(10)} ${colors().dim('not run')}`);
      continue;
    }
    if (!extractor.applicable) {
      logger.info(`  ${id.padEnd(10)} ${colors().dim('not applicable')}`);
      continue;
    }
    const gaps = extractor.gaps.length > 0 ? colors().yellow(`  ${extractor.gaps.length} not determined`) : '';
    logger.info(`  ${id.padEnd(10)} ${String(extractor.entries.length).padStart(4)} entries${gaps}`);
  }

  if (result.stack.unsupported.length > 0) {
    logger.warn(
      `${result.stack.unsupported.length} detected technolog${result.stack.unsupported.length === 1 ? 'y is' : 'ies are'} ` +
        'not documented, so these counts understate the repository:',
    );
    for (const tech of result.stack.unsupported) {
      logger.warn(`  ${tech.name} (${tech.evidence.file})`);
    }
  }
}

function renderFindings(
  report: Awaited<ReturnType<typeof computeFindings>>,
  full: boolean,
  logger: Logger,
): void {
  logger.heading('Findings');

  for (const finding of report.findings) {
    if (finding.unavailable !== undefined) {
      logger.info(`  ${colors().dim('skipped')}  ${finding.title}`);
      logger.info(`           ${colors().dim(finding.unavailable)}`);
      continue;
    }

    if (finding.items.length === 0) {
      logger.info(`  ${colors().green('clean')}    ${finding.title}`);
      continue;
    }

    logger.info(`  ${colors().yellow(String(finding.items.length).padStart(5))}    ${finding.title}`);

    const items = sortItems(finding.items);
    const shown = full ? items : items.slice(0, PREVIEW_LIMIT);
    for (const item of shown) {
      // The label is often the file itself; repeating it adds nothing.
      const where =
        item.source === undefined || item.source.file === item.label
          ? item.detail === undefined
            ? ''
            : colors().dim(` — ${item.detail}`)
          : colors().dim(` — ${item.source.file}`);
      logger.info(`           ${item.label}${where}`);
    }
    if (!full && items.length > shown.length) {
      logger.info(`           ${colors().dim(`… ${items.length - shown.length} more (use --full)`)}`);
    }
  }

  if (report.totalItems === 0) {
    logger.info(`\n  ${colors().dim('Nothing to report.')}`);
    return;
  }

  // These are observations, not defects. Saying so keeps the list credible.
  logger.info(
    `\n  ${colors().dim(
      `${report.totalItems} observation(s). Each states what it compared and what it cannot prove — ` +
        'review before acting.',
    )}`,
  );
}
