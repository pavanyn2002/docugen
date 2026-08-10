import path from 'node:path';
import { colors } from '../util/colors.js';
import { EXTRACTOR_IDS } from '../types/core.js';
import type { ExtractorId } from '../types/core.js';
import { loadConfig } from '../config/load.js';
import { runExtraction } from '../pipeline.js';
import type { RunResult } from '../pipeline.js';
import { writeAll } from '../render/index.js';
import { DocgenError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { compareStrings } from '../util/sort.js';

export interface ExtractCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  readonly outDir?: string;
  readonly only?: string;
  readonly json: boolean;
  /** Skip writing files; report what would be produced. */
  readonly dryRun?: boolean;
  readonly logger: Logger;
}

/** Parse and validate `--only routes,schema`. */
export function parseOnly(value: string | undefined): readonly ExtractorId[] | undefined {
  if (value === undefined) return undefined;

  const requested = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const invalid = requested.filter((part) => !(EXTRACTOR_IDS as readonly string[]).includes(part));
  if (invalid.length > 0) {
    throw new DocgenError({
      code: 'invalid-extractor',
      message: `Unknown extractor(s): ${invalid.join(', ')}`,
      remedy: `Valid extractors are: ${EXTRACTOR_IDS.join(', ')}.`,
    });
  }

  return requested as readonly ExtractorId[];
}

/**
 * `docgen extract` — the static lane. No network, no LLM, no cost.
 *
 * Extracts, renders, and writes the documentation set. Use --dry-run to see
 * what would be produced without touching the target repo.
 */
export async function runExtractCommand(options: ExtractCommandOptions): Promise<RunResult> {
  const only = parseOnly(options.only);

  const loaded = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });

  const config = options.outDir === undefined ? loaded : { ...loaded, outDir: options.outDir };

  const result = await runExtraction({
    config,
    logger: options.logger,
    ...(only === undefined ? {} : { only }),
  });

  const write = options.dryRun !== true;
  const report = write ? await writeAll(result) : undefined;

  if (options.json) {
    options.logger.output(
      JSON.stringify({ ...(serialiseRunResult(result) as object), written: report?.written ?? [] }, null, 2),
    );
    return result;
  }

  reportRun(result, options.logger);
  reportWrites(report, options.dryRun === true, options.logger);
  return result;
}

function reportWrites(
  report: { written: readonly string[]; outDir: string; gitattributesUpdated: boolean } | undefined,
  dryRun: boolean,
  logger: Logger,
): void {
  if (dryRun) {
    logger.heading('Output');
    logger.info(`  ${colors().dim('--dry-run: no files were written')}`);
    return;
  }
  if (report === undefined) return;

  logger.heading(`Written (${report.written.length})`);
  for (const file of report.written) logger.info(`  ${file}`);
  if (report.gitattributesUpdated) {
    logger.info(`  ${colors().dim('.gitattributes updated with linguist-generated')}`);
  }
}

/** JSON shape for `--json`. Excludes durations, which are not reproducible. */
function serialiseRunResult(result: RunResult): unknown {
  return {
    engineVersion: result.context.engineVersion,
    sourceCommit: result.context.sourceCommit ?? null,
    root: result.config.root,
    outDir: result.config.outDir,
    extractors: Object.fromEntries(
      [...result.results.entries()].map(([id, value]) => [
        id,
        {
          applicable: value.applicable,
          detected: [...value.detected],
          entryCount: value.entries.length,
          gaps: value.gaps.map((gap) => ({ kind: gap.kind, message: gap.message, source: gap.source ?? null })),
          skips: value.skips.map((s) => ({ kind: s.kind, message: s.message })),
        },
      ]),
    ),
    unimplemented: [...result.unimplemented],
    disabled: [...result.disabled],
    stack: {
      workspaces: result.stack.workspaces.map((workspace) => workspace.dir),
      technologies: result.stack.technologies.map((tech) => ({
        id: tech.id,
        name: tech.name,
        category: tech.category,
        workspace: tech.workspace,
        evidence: tech.evidence.file,
        supported: tech.covers.length > 0,
        covers: [...tech.covers],
      })),
      unsupported: result.stack.unsupported.map((tech) => tech.id),
    },
  };
}

function reportRun(result: RunResult, logger: Logger): void {
  const configLabel =
    result.config.configFile === undefined
      ? colors().dim('(defaults — no docgen.config found)')
      : colors().dim(path.relative(result.config.root, result.config.configFile));

  logger.heading('docgen extract');
  logger.info(`  root      ${result.config.root}`);
  logger.info(`  config    ${configLabel}`);
  logger.info(`  outDir    ${result.config.outDir}`);
  logger.info(`  commit    ${result.context.sourceCommit ?? colors().dim('(not a git checkout)')}`);

  if (result.results.size > 0) {
    logger.heading('Extractors');
    for (const [id, value] of [...result.results.entries()].sort(([a], [b]) =>compareStrings(a, b))) {
      const status = value.applicable ? `${value.entries.length} entries` : colors().dim('not applicable');
      const gaps = value.gaps.length > 0 ? colors().yellow(` ${value.gaps.length} gaps`) : '';
      logger.info(`  ${id.padEnd(10)} ${status}${gaps}`);
    }
  }

  if (result.disabled.length > 0) {
    logger.info(`\n  ${colors().dim(`disabled: ${result.disabled.join(', ')}`)}`);
  }

  if (result.unimplemented.length > 0) {
    logger.warn(
      `not implemented yet: ${result.unimplemented.join(', ')} — ` +
        'no documentation was generated for these.',
    );
  }

  reportStack(result, logger);

  logger.info(`\n  ${colors().dim(`completed in ${result.totalDurationMs}ms`)}`);
}

/**
 * Report the detected stack, and warn loudly about anything docgen cannot
 * parse.
 *
 * This is the difference between "your repo has no API endpoints" and "docgen
 * cannot read Django". Both produce an empty section; only one is the truth,
 * and a reader has no way to tell them apart unless it is stated.
 */
function reportStack(result: RunResult, logger: Logger): void {
  const { technologies, unsupported, workspaces } = result.stack;
  if (technologies.length === 0) return;

  logger.heading('Detected stack');
  if (workspaces.length > 1) {
    logger.info(`  ${colors().dim(`${workspaces.length} workspaces`)}`);
  }
  const unsupportedIds = new Set(unsupported.map((tech) => `${tech.id}@${tech.workspace}`));
  for (const tech of technologies) {
    const where = tech.workspace === '' ? '' : colors().dim(` in ${tech.workspace}/`);
    // Three states, not two: documented, a real coverage gap, or context that
    // was never docgen's job to extract.
    const mark = unsupportedIds.has(`${tech.id}@${tech.workspace}`)
      ? colors().yellow('gap')
      : tech.covers.length > 0
        ? colors().green(' ok')
        : colors().dim('  -');
    logger.info(`  ${mark} ${tech.name}${where}`);
  }

  // A `!re-included` path is excluded here but tracked by git, so its absence
  // from the output would otherwise look like the repo simply has nothing there.
  const negations = result.config.gitignoreNegations;
  if (negations.length > 0) {
    logger.warn(
      `.gitignore has ${negations.length} re-inclusion rule(s) docgen cannot apply, so files ` +
        'they restore are excluded. Add them to `include` in docgen.config if they hold source:',
    );
    for (const negation of negations.slice(0, 5)) logger.warn(`  ${negation}`);
  }

  if (unsupported.length > 0) {
    logger.warn(
      `docgen cannot document ${unsupported.length} detected technolog${unsupported.length === 1 ? 'y' : 'ies'}. ` +
        'The output below is incomplete — an empty section does not mean the repo has nothing there:',
    );
    for (const tech of unsupported) {
      logger.warn(
        `  ${tech.name} (${tech.evidence.file})` +
          (tech.unsupportedNote === undefined ? '' : ` — ${tech.unsupportedNote}`),
      );
    }
  }
}
