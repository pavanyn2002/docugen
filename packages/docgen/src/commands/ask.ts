import { colors } from '../util/colors.js';
import { loadConfig } from '../config/load.js';
import { loadCards } from '../infer/store.js';
import { loadAnswers } from '../questions/store.js';
import { buildQueue, currentGitEmail, lastAuthorOf } from '../questions/queue.js';
import type { Question } from '../questions/queue.js';
import type { Logger } from '../util/logger.js';

export interface AskCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  /** Only questions attributed to the current git user. */
  readonly mine?: boolean;
  /** Only questions for one surface. */
  readonly surface?: string;
  readonly limit?: number;
  readonly json: boolean;
  readonly logger: Logger;
}

/**
 * `docgen ask` — the open question queue.
 *
 * Questions surface where the developer already is: their terminal, or the
 * coding agent driving it. There is no separate inbox to check and no
 * integration to maintain — a question is a `docgen answer` command away from
 * becoming permanent ground truth.
 *
 * This command only reads. Answering is a separate, explicit step, so nothing
 * gets recorded because someone scrolled past it.
 */
export async function runAskCommand(options: AskCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });

  const cards = await loadCards(config.root);
  const answers = await loadAnswers(config.root);

  if (cards.size === 0) {
    options.logger.warn(
      'No feature cards exist yet, so there are no questions. Run `docgen bootstrap` first.',
    );
    return;
  }

  // Owners are resolved only for the surfaces that still have open questions —
  // a `git log` per surface across a large repo is not worth paying for
  // questions nobody is going to be shown.
  const owners = new Map<string, { email: string; file: string }>();
  const cardList = [...cards.values()];
  for (const card of cardList) {
    const answered = new Set((answers.get(card.surfaceId)?.answers ?? []).map((a) => a.questionId));
    if (card.body.unknowns.every((unknown) => answered.has(unknown.id))) continue;
    const file = card.body.summary.evidence[0]?.file;
    if (file === undefined) continue;
    const email = await lastAuthorOf(config.root, file);
    if (email !== undefined) owners.set(card.surfaceId, { email, file });
  }

  const queue = buildQueue({ cards: cardList, answers, ownersBySurface: owners });
  const me = options.mine === true ? await currentGitEmail(config.root) : undefined;

  let questions = queue.questions;
  if (options.surface !== undefined) {
    const needle = options.surface.toLowerCase();
    questions = questions.filter(
      (question) =>
        question.slug.toLowerCase().includes(needle) ||
        question.surfaceTitle.toLowerCase().includes(needle),
    );
  }
  if (me !== undefined) {
    questions = questions.filter((question) => question.likelyOwner === me);
  }

  if (options.json) {
    options.logger.output(
      JSON.stringify(
        {
          total: queue.questions.length,
          shown: questions.length,
          filteredBy: { mine: me ?? null, surface: options.surface ?? null },
          questions: questions.map((question) => ({
            surfaceId: question.surfaceId,
            slug: question.slug,
            surface: question.surfaceTitle,
            id: question.unknown.id,
            question: question.unknown.question,
            why: question.unknown.why,
            options: question.unknown.options,
            likelyOwner: question.likelyOwner ?? null,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (options.mine === true && me === undefined) {
    options.logger.warn(
      '--mine needs a git identity, and `git config user.email` returned nothing. Showing all questions.',
    );
  }

  options.logger.heading(`Open questions (${questions.length} of ${queue.questions.length})`);

  if (questions.length === 0) {
    options.logger.info(
      `  ${colors().dim(
        queue.questions.length === 0
          ? 'Nothing is waiting on an answer.'
          : 'None match that filter.',
      )}`,
    );
    return;
  }

  const shown = options.limit === undefined ? questions : questions.slice(0, options.limit);
  for (const question of shown) {
    renderQuestion(question, options.logger);
  }

  if (shown.length < questions.length) {
    options.logger.info(`  ${colors().dim(`… ${questions.length - shown.length} more`)}`);
  }

  options.logger.info(
    `\n  ${colors().dim(
      'Answer one with:  docgen answer <surface-slug> <question-id> "your answer"',
    )}`,
  );
}

function renderQuestion(question: Question, logger: Logger): void {
  logger.info('');
  logger.info(`  ${colors().bold(question.unknown.question)}`);
  logger.info(`    ${colors().dim(`surface: ${question.slug}   id: ${question.unknown.id}`)}`);
  logger.info(`    ${colors().dim(`why asked: ${question.unknown.why}`)}`);

  if (question.likelyOwner !== undefined) {
    logger.info(`    ${colors().dim(`last touched by: ${question.likelyOwner}`)}`);
  }

  if (question.unknown.options.length > 0) {
    for (const [index, option] of question.unknown.options.entries()) {
      logger.info(`      ${index + 1}. ${option}`);
    }
  }
}
