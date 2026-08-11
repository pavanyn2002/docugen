import { colors } from '../util/colors.js';
import { collectStatus } from '../status/collect.js';
import type { Logger } from '../util/logger.js';

export interface StatusCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  readonly json?: boolean;
  readonly logger: Logger;
}

/**
 * `docgen status` — one repository's documentation health.
 *
 * Every number is paired with what it is a number of. "12 requirements" says
 * nothing on its own; "12 requirements across 40 surfaces, 34 of which nobody
 * has described" says what to do next. Calls no model, so this is safe to run
 * anywhere, including across a whole fleet.
 */
export async function runStatusCommand(options: StatusCommandOptions): Promise<void> {
  const status = await collectStatus({
    cwd: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
    logger: options.logger,
  });

  if (options.json === true) {
    options.logger.output(JSON.stringify(status, null, 2));
    return;
  }

  const requirementTotal = Object.values(status.requirements).reduce((a, b) => a + b, 0);

  options.logger.heading(status.name);
  options.logger.info(`  surfaces      ${status.described}/${status.surfaces} described`);
  options.logger.info(`  questions     ${status.openQuestions} open, ${status.answered} answered`);
  options.logger.info(`  untriaged     ${status.untriaged} answer(s)`);
  options.logger.info(
    `  requirements  ${requirementTotal} ` +
      `(${status.requirements.requirement} intended, ${status.requirements.bug} defects, ` +
      `${status.requirements.decision} decisions)`,
  );
  options.logger.info(`  traced        ${status.tested}/${status.testable} cited by a test`);
  options.logger.info(
    `  graph         ${status.graph.nodes} nodes, ${status.graph.edges} edges, ${status.graph.gaps} evidence gap(s)`,
  );
  options.logger.info(
    `  governance    ${status.graph.features} feature(s), ${status.graph.plans} plan(s), ${status.graph.changes} change record(s)`,
  );
  options.logger.info(
    `  drift         ${
      status.driftingFiles === 0 ? colors().green('up to date') : `${status.driftingFiles} file(s) stale`
    }`,
  );

  if (status.unsupportedTechnologies.length > 0) {
    options.logger.warn(
      `Counts are lower bounds: docgen cannot parse ${status.unsupportedTechnologies.join(', ')}.`,
    );
  }

  options.logger.info(`\n  ${colors().dim(nextStep(status))}`);
}

function nextStep(status: Awaited<ReturnType<typeof collectStatus>>): string {
  if (status.driftingFiles > 0) return 'Next: `docgen sync` — the generated files are out of date.';
  if (status.described === 0 && status.surfaces > 0) return 'Next: `docgen bootstrap` — nothing has been described yet.';
  if (status.openQuestions > 0) return 'Next: `docgen ask --mine` — questions are waiting on a developer.';
  if (status.untriaged > 0) return 'Next: `docgen triage` — answers are waiting to be classified.';
  if (status.untestedRequirements > 0) return 'Next: cite the untested requirement ids in tests — see traceability.md.';
  return 'Nothing outstanding.';
}
