import { colors } from '../util/colors.js';
import { loadConfig } from '../config/load.js';
import { runExtraction } from '../pipeline.js';
import { computeExpectedFiles, findDrift } from '../verify/expected.js';
import { loadCards } from '../infer/store.js';
import { loadAnswers } from '../questions/store.js';
import { loadRequirements } from '../requirements/store.js';
import { buildQueue } from '../questions/queue.js';
import { buildPending } from '../requirements/pending.js';
import { DocgenError } from '../util/errors.js';
import { toPosix } from '../util/paths.js';
import type { Logger } from '../util/logger.js';

export interface CheckCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  /** Also fail when questions are unanswered or answers untriaged. */
  readonly strict?: boolean;
  readonly json?: boolean;
  readonly logger: Logger;
}

/**
 * `docgen check` — the CI gate.
 *
 * Fails when the committed documentation no longer matches the code. This is
 * what keeps the whole thing from rotting: documentation that is allowed to
 * drift silently becomes documentation nobody trusts, and documentation nobody
 * trusts is the problem this tool exists to solve.
 *
 * It never calls a model. A gate that costs money per pull request would be
 * turned off within a month, and one whose result depends on a model returning
 * the same words twice would be flaky. Inferred content is read from the
 * committed cards, so what is checked is whether the *rendering* is current.
 */
export async function runCheckCommand(options: CheckCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });

  const run = await runExtraction({ config, logger: options.logger });
  const expected = await computeExpectedFiles(run);
  const drift = await findDrift(config.root, toPosix(config.outDir), expected);

  const cards = [...(await loadCards(config.root)).values()];
  const answers = await loadAnswers(config.root);
  const requirements = await loadRequirements(config.root);
  const openQuestions = buildQueue({ cards, answers }).questions.length;
  const untriaged = buildPending({ cards, answers, requirements }).length;

  if (options.json === true) {
    options.logger.output(
      JSON.stringify(
        {
          ok: drift.length === 0 && !(options.strict === true && (openQuestions > 0 || untriaged > 0)),
          drift,
          openQuestions,
          untriagedAnswers: untriaged,
          checkedFiles: expected.length,
        },
        null,
        2,
      ),
    );
  } else {
    report(drift, expected.length, openQuestions, untriaged, options);
  }

  if (drift.length > 0) {
    throw new DocgenError({
      code: 'documentation-drift',
      message: `The committed documentation is out of date: ${drift.length} file(s) would change.`,
      remedy:
        'Run `docgen sync` and commit the result. If a page changed because a card was ' +
        'hand-edited, that edit is lost by design — record the correction with `docgen answer`.',
    });
  }

  if (options.strict === true && (openQuestions > 0 || untriaged > 0)) {
    throw new DocgenError({
      code: 'unresolved-questions',
      message:
        `--strict: ${openQuestions} question(s) unanswered and ${untriaged} answer(s) untriaged.`,
      remedy:
        'Run `docgen ask --mine` to answer, then `docgen triage` to classify. Drop --strict ' +
        'if this gate should only check that the generated files are current.',
    });
  }
}

function report(
  drift: readonly { file: string; kind: string }[],
  checked: number,
  openQuestions: number,
  untriaged: number,
  options: CheckCommandOptions,
): void {
  options.logger.heading('docgen check');
  options.logger.info(`  checked   ${checked} generated file(s)`);
  options.logger.info(`  questions ${openQuestions} unanswered`);
  options.logger.info(`  untriaged ${untriaged} answer(s)`);

  if (drift.length === 0) {
    options.logger.info(`\n  ${colors().green('up to date')}`);
    return;
  }

  options.logger.heading(`Out of date (${drift.length})`);
  for (const item of drift.slice(0, 40)) {
    const label =
      item.kind === 'missing'
        ? colors().dim('missing ')
        : item.kind === 'orphaned'
          ? colors().dim('orphaned')
          : colors().dim('changed ');
    options.logger.info(`  ${label} ${item.file}`);
  }
  if (drift.length > 40) options.logger.info(`  ${colors().dim(`… and ${drift.length - 40} more`)}`);

  options.logger.info(
    `\n  ${colors().dim(
      'orphaned means a page documents something that no longer exists — worse than a stale ' +
        'page, because nothing about it looks wrong.',
    )}`,
  );
}
