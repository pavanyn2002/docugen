import { colors } from '../util/colors.js';
import { loadConfig } from '../config/load.js';
import { loadCards } from '../infer/store.js';
import { loadAnswers, recordAnswer } from '../questions/store.js';
import { currentGitEmail } from '../questions/queue.js';
import { DocgenError } from '../util/errors.js';
import { compareStrings } from '../util/sort.js';
import type { Logger } from '../util/logger.js';

export interface AnswerCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  readonly surface: string;
  readonly questionId: string;
  /** The answer text, or the 1-based index of one of the offered options. */
  readonly answer: string;
  readonly note?: string;
  readonly logger: Logger;
}

/**
 * `docgen answer` — record a developer's answer as ground truth.
 *
 * This is the only path by which a claim becomes `verified`. It is deliberately
 * explicit and deliberately cheap: one command, no model call, no network. The
 * answer is written to `docs/.answers/` and injected into every subsequent
 * generation, so the question is never asked again and the model can never
 * contradict it.
 */
export async function runAnswerCommand(options: AnswerCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });

  const cards = await loadCards(config.root);
  const card = [...cards.values()].find(
    (candidate) => candidate.slug === options.surface || candidate.surfaceId === options.surface,
  );

  if (card === undefined) {
    const known = [...cards.values()].map((candidate) => candidate.slug).sort(compareStrings);
    throw new DocgenError({
      code: 'unknown-surface',
      message: `No feature card matches '${options.surface}'.`,
      remedy:
        known.length === 0
          ? 'Run `docgen bootstrap` first to generate cards.'
          : `Known surfaces: ${known.slice(0, 20).join(', ')}${known.length > 20 ? ', …' : ''}`,
    });
  }

  const unknown = card.body.unknowns.find((candidate) => candidate.id === options.questionId);
  if (unknown === undefined) {
    const ids = card.body.unknowns.map((candidate) => candidate.id);
    throw new DocgenError({
      code: 'unknown-question',
      message: `Surface '${card.slug}' has no open question with id '${options.questionId}'.`,
      remedy:
        ids.length === 0
          ? 'This surface has no unanswered questions.'
          : `Its question ids are: ${ids.join(', ')}`,
    });
  }

  // A numeric answer selects one of the offered options, so answering is a
  // keystroke rather than a sentence — which is the entire reason developers
  // engage with this at all.
  const chosen = resolveAnswerText(options.answer, unknown.options);

  const existing = (await loadAnswers(config.root)).get(card.surfaceId);
  const previous = existing?.answers.find((answer) => answer.questionId === options.questionId);

  await recordAnswer({
    root: config.root,
    surfaceId: card.surfaceId,
    slug: card.slug,
    answer: {
      questionId: unknown.id,
      question: unknown.question,
      answer: chosen,
      answeredBy: (await currentGitEmail(config.root)) ?? 'unknown',
      answeredAt: new Date().toISOString(),
      ...(options.note === undefined ? {} : { note: options.note }),
    },
  });

  options.logger.heading('Answer recorded');
  options.logger.info(`  surface   ${card.slug}`);
  options.logger.info(`  question  ${unknown.question}`);
  options.logger.info(`  answer    ${chosen}`);
  if (previous !== undefined) {
    options.logger.info(`  ${colors().dim(`replaced a previous answer: ${previous.answer}`)}`);
  }
  options.logger.info(`\n  ${colors().dim(`written to docs/.answers/${card.slug}.yaml`)}`);
  options.logger.info(
    `  ${colors().dim(
      'This is now ground truth: it will be shown as verified, injected into every future ' +
        'generation, and the question will not be asked again.',
    )}`,
  );
}

/** A bare number picks an offered option; anything else is used verbatim. */
export function resolveAnswerText(input: string, options: readonly string[]): string {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return trimmed;

  const index = Number(trimmed);
  const chosen = options[index - 1];
  if (chosen === undefined) {
    throw new DocgenError({
      code: 'invalid-option',
      message:
        options.length === 0
          ? `This question offers no numbered options, so '${trimmed}' was read as an option number ` +
            'and there is nothing to select.'
          : `There is no option ${index} for this question.`,
      remedy:
        options.length === 0
          ? 'Write the answer out in full instead.'
          : `Valid options are 1–${options.length}, or write the answer out in full.`,
    });
  }
  return chosen;
}
