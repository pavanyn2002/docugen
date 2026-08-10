import { colors } from '../util/colors.js';
import { loadConfig } from '../config/load.js';
import { loadCards } from '../infer/store.js';
import { loadAnswers } from '../questions/store.js';
import { loadRequirements } from '../requirements/store.js';
import { scanTestReferences } from '../trace/scan.js';
import { buildMatrix } from '../trace/matrix.js';
import { syncGenerated } from '../verify/write.js';
import type { SyncReport } from '../verify/write.js';
import { DocgenError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

export interface TraceCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  readonly json?: boolean;
  /** Exit non-zero when any of the three gaps is non-empty. */
  readonly strict?: boolean;
  readonly logger: Logger;
}

/**
 * `docgen trace` — link requirements to the tests that check them.
 *
 * The matrix itself is not the point. The three gaps it exposes are, and each
 * needs a different person: a requirement with no test is untested behaviour
 * someone agreed to, a test citing a missing id is a broken link, and a surface
 * with nothing confirmed at all is behaviour nobody has agreed on and nothing
 * checks. Only the first is usually noticed without a tool.
 */
export async function runTraceCommand(options: TraceCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });

  const cards = [...(await loadCards(config.root)).values()];
  const answers = await loadAnswers(config.root);
  const requirements = await loadRequirements(config.root);

  const references = await scanTestReferences({
    root: config.root,
    globs: config.trace.include,
    exclude: config.effectiveExclude,
  });

  const matrix = buildMatrix({ requirements, cards, references, answers });

  // Writing through the shared path keeps the repo passing `docgen check`,
  // and regenerates the pages that depend on the matrix.
  const sync = await syncGenerated({ config, logger: options.logger });

  if (options.json === true) {
    options.logger.output(
      JSON.stringify(
        {
          testable: matrix.testableCount,
          tested: matrix.testedCount,
          untested: matrix.untested.map((row) => row.requirement.id),
          danglingReferences: matrix.danglingReferences,
          untracedSurfaces: matrix.untracedSurfaces.map((surface) => surface.slug),
          testFilesScanned: new Set(references.map((reference) => reference.file)).size,
        },
        null,
        2,
      ),
    );
  } else {
    report(matrix, references.length, sync, options.logger);
  }

  if (
    options.strict === true &&
    (matrix.untested.length > 0 ||
      matrix.danglingReferences.length > 0 ||
      matrix.untracedSurfaces.length > 0)
  ) {
    throw new DocgenError({
      code: 'traceability-gaps',
      message:
        `--strict: ${matrix.untested.length} untested requirement(s), ` +
        `${matrix.danglingReferences.length} broken reference(s), ` +
        `${matrix.untracedSurfaces.length} surface(s) with nothing confirmed.`,
      remedy:
        'Cite the requirement id in a test name or comment to close the first, fix or remove ' +
        'the citation to close the second, and answer and triage a question on the surface to ' +
        'close the third.',
    });
  }
}

function report(
  matrix: ReturnType<typeof buildMatrix>,
  referenceCount: number,
  sync: SyncReport,
  logger: Logger,
): void {
  const percent =
    matrix.testableCount === 0 ? 0 : Math.round((matrix.testedCount / matrix.testableCount) * 100);

  logger.heading('docgen trace');
  logger.info(`  requirements  ${matrix.rows.length} (${matrix.testableCount} testable)`);
  logger.info(`  citations     ${referenceCount} found in tests`);
  logger.info(`  covered       ${matrix.testedCount}/${matrix.testableCount} (${percent}%)`);

  logger.heading('Gaps');
  logger.info(`  ${label(matrix.untested.length)} requirement(s) with no test`);
  logger.info(`  ${label(matrix.danglingReferences.length)} test(s) citing an unknown requirement`);
  logger.info(`  ${label(matrix.untracedSurfaces.length)} surface(s) with nothing confirmed at all`);

  for (const row of matrix.untested.slice(0, 10)) {
    logger.info(`    ${colors().dim(`untested  ${row.requirement.id} — ${row.requirement.statement}`)}`);
  }
  for (const reference of matrix.danglingReferences.slice(0, 10)) {
    logger.info(
      `    ${colors().dim(`unknown   ${reference.id} at ${reference.file}:${reference.line}`)}`,
    );
  }

  // Naming files that were not written is the same class of error this tool
  // exists to catch: with nothing triaged there is no matrix to render, and
  // claiming otherwise sends the reader looking for a page that is not there.
  const traceFiles = sync.written.filter(
    (file) => file.endsWith('test-cases.md') || file.endsWith('traceability.md'),
  );
  logger.info(
    `\n  ${colors().dim(
      traceFiles.length > 0
        ? `written to ${traceFiles.join(' and ')}`
        : 'nothing written — no requirement has been triaged yet, so there is no matrix to render',
    )}`,
  );
}

/** Zero is the good outcome here, so it is the one that gets the colour. */
function label(count: number): string {
  return count === 0 ? colors().green(String(count).padStart(3)) : String(count).padStart(3);
}
