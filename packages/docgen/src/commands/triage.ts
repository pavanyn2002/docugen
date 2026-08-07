import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import * as readline from 'node:readline/promises';
import { colors } from '../util/colors.js';
import { loadConfig } from '../config/load.js';
import { loadCards } from '../infer/store.js';
import { loadAnswers } from '../questions/store.js';
import { currentGitEmail } from '../questions/queue.js';
import { buildPending } from '../requirements/pending.js';
import type { PendingItem } from '../requirements/pending.js';
import { loadRequirements, recordRequirement } from '../requirements/store.js';
import { countByKind, renderRequirementsPage } from '../requirements/render.js';
import { KIND_LABELS, REQUIREMENT_KINDS } from '../requirements/types.js';
import type { RequirementKind } from '../requirements/types.js';
import { resolveCommitInfo } from '../util/git.js';
import { DocgenError } from '../util/errors.js';
import { toPosix } from '../util/paths.js';
import { ENGINE_VERSION } from '../util/version.js';
import type { Logger } from '../util/logger.js';

export interface TriageCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  /** Show what is waiting and exit, changing nothing. */
  readonly list?: boolean;
  readonly json?: boolean;
  /** Non-interactive: classify one answered question. */
  readonly surface?: string;
  readonly questionId?: string;
  readonly kind?: string;
  readonly note?: string;
  readonly logger: Logger;
}

/**
 * `docgen triage` — decide what an answer means.
 *
 * An answer establishes what happens. It does not establish whether that is
 * intended, and those lead to opposite outcomes: one becomes a requirement QA
 * tests against, the other becomes a bug. Only a developer can tell them apart,
 * so this is the one step that cannot be automated away — but it is one
 * keystroke per question, and it is the step that finally produces a document
 * QA can treat as a specification.
 */
export async function runTriageCommand(options: TriageCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });

  const cards = [...(await loadCards(config.root)).values()];
  const answers = await loadAnswers(config.root);
  const requirements = await loadRequirements(config.root);
  const pending = buildPending({ cards, answers, requirements });

  if (options.list === true || options.json === true) {
    reportPending(pending, options);
    return;
  }

  if (options.surface !== undefined) {
    await triageOne(config.root, toPosix(config.outDir), pending, options);
    return;
  }

  await triageInteractively(config.root, toPosix(config.outDir), pending, options);
}

function reportPending(pending: readonly PendingItem[], options: TriageCommandOptions): void {
  if (options.json === true) {
    options.logger.output(
      JSON.stringify(
        {
          pending: pending.length,
          kinds: REQUIREMENT_KINDS,
          items: pending.map((item) => ({
            surface: item.slug,
            surfaceId: item.surfaceId,
            questionId: item.answer.questionId,
            question: item.answer.question,
            answer: item.answer.answer,
            answeredBy: item.answer.answeredBy,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  options.logger.heading(`Awaiting triage (${pending.length})`);
  if (pending.length === 0) {
    options.logger.info(`  ${colors().dim('Every answer has been classified.')}`);
    return;
  }

  for (const item of pending) {
    options.logger.info('');
    options.logger.info(`  ${colors().bold(item.answer.question)}`);
    options.logger.info(`    ${colors().dim(`${item.slug} · ${item.answer.questionId}`)}`);
    options.logger.info(`    answered: ${item.answer.answer}`);
  }
}

/** The non-interactive path, so an agent can record a developer's decision. */
async function triageOne(
  root: string,
  outDir: string,
  pending: readonly PendingItem[],
  options: TriageCommandOptions,
): Promise<void> {
  if (options.questionId === undefined || options.kind === undefined) {
    throw new DocgenError({
      code: 'triage-incomplete',
      message: 'Classifying one question needs a surface, a question id, and a kind.',
      remedy: `Usage: docgen triage <surface> <question-id> <${REQUIREMENT_KINDS.join('|')}>`,
    });
  }

  const kind = REQUIREMENT_KINDS.find((candidate) => candidate === options.kind);
  if (kind === undefined) {
    throw new DocgenError({
      code: 'unknown-kind',
      message: `'${options.kind}' is not a classification docgen recognises.`,
      remedy: `Valid kinds are: ${REQUIREMENT_KINDS.join(', ')}.`,
    });
  }

  const item = pending.find(
    (candidate) =>
      (candidate.slug === options.surface || candidate.surfaceId === options.surface) &&
      candidate.answer.questionId === options.questionId,
  );

  if (item === undefined) {
    throw new DocgenError({
      code: 'nothing-to-triage',
      message: `No untriaged answer matches surface '${options.surface}' and question '${options.questionId}'.`,
      remedy:
        'Run `docgen triage --list` to see what is waiting. An answer that is already ' +
        'classified will not appear; re-run with the same arguments to reclassify it only ' +
        'after removing its entry from docs/.requirements/.',
    });
  }

  const recorded = await record(root, item, kind, options);
  await rewrite(root, outDir);

  options.logger.heading('Triaged');
  options.logger.info(`  ${recorded.id}  ${KIND_LABELS[kind]}`);
  options.logger.info(`  ${recorded.statement}`);
}

async function triageInteractively(
  root: string,
  outDir: string,
  pending: readonly PendingItem[],
  options: TriageCommandOptions,
): Promise<void> {
  if (pending.length === 0) {
    options.logger.heading('Nothing to triage');
    options.logger.info(
      `  ${colors().dim(
        'Every recorded answer has been classified. Answer more questions with `docgen ask`.',
      )}`,
    );
    return;
  }

  if (!process.stdin.isTTY) {
    // Prompting a pipe would hang forever, or read EOF and record a wrong
    // classification. Both are worse than saying what to run instead.
    throw new DocgenError({
      code: 'not-interactive',
      message: 'Interactive triage needs a terminal, and this is not one.',
      remedy:
        'Use the non-interactive form: `docgen triage <surface> <question-id> <kind>`, ' +
        'or `docgen triage --list --json` to see what is waiting.',
    });
  }

  options.logger.heading(`Triage (${pending.length} to classify)`);
  options.logger.info(
    `  ${colors().dim('One keystroke each. Ctrl-C stops; everything decided so far is kept.')}\n`,
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  let done = 0;

  try {
    for (const [index, item] of pending.entries()) {
      options.logger.info(`  ${colors().dim(`[${index + 1}/${pending.length}] ${item.slug}`)}`);
      options.logger.info(`  ${colors().bold(item.answer.question)}`);
      options.logger.info(`  answered: ${item.answer.answer}\n`);

      const choice = await rl.question(
        `  ${REQUIREMENT_KINDS.map((kind, at) => `[${at + 1}] ${KIND_LABELS[kind]}`).join('  ')}\n` +
          '  [s] skip  [q] quit\n  > ',
      );

      const normalised = choice.trim().toLowerCase();
      if (normalised === 'q') break;
      if (normalised === 's' || normalised === '') {
        options.logger.info(`  ${colors().dim('skipped')}\n`);
        continue;
      }

      const kind = REQUIREMENT_KINDS[Number(normalised) - 1];
      if (kind === undefined) {
        options.logger.warn(`  '${choice.trim()}' is not one of the options — skipped.\n`);
        continue;
      }

      const recorded = await record(root, item, kind, options);
      done += 1;
      options.logger.info(`  ${colors().green(recorded.id)} ${KIND_LABELS[kind]}\n`);
    }
  } finally {
    rl.close();
  }

  await rewrite(root, outDir);

  const counts = countByKind(await loadRequirements(root));
  options.logger.heading('Result');
  options.logger.info(`  classified  ${done} this session`);
  for (const kind of REQUIREMENT_KINDS) {
    if (counts[kind] > 0) options.logger.info(`  ${KIND_LABELS[kind].padEnd(20)} ${counts[kind]}`);
  }
  options.logger.info(`\n  ${colors().dim(`written to ${outDir}/requirements.md`)}`);
}

async function record(
  root: string,
  item: PendingItem,
  kind: RequirementKind,
  options: TriageCommandOptions,
): ReturnType<typeof recordRequirement> {
  return recordRequirement({
    root,
    surfaceId: item.surfaceId,
    slug: item.slug,
    kind,
    // The question, verbatim. Rewording it into a requirement sentence would be
    // a behavioural claim docgen did not get from anyone.
    title: item.answer.question,
    statement: item.answer.answer,
    questionId: item.answer.questionId,
    recordedBy: (await currentGitEmail(root)) ?? 'unknown',
    recordedAt: new Date().toISOString(),
    ...(options.note === undefined ? {} : { note: options.note }),
  });
}

/** Rewrite the requirements page from what is now on disk. */
async function rewrite(root: string, outDir: string): Promise<void> {
  const requirements = await loadRequirements(root);
  const cards = [...(await loadCards(root)).values()];
  const answers = await loadAnswers(root);
  const pending = buildPending({ cards, answers, requirements });
  const commit = await resolveCommitInfo(root);

  const contents = renderRequirementsPage({
    requirements,
    pendingCount: pending.length,
    context: {
      engineVersion: ENGINE_VERSION,
      ...(commit === undefined ? {} : { sourceCommit: commit.sha, generatedAt: commit.committedAt }),
    },
  });

  const file = path.join(root, outDir, 'requirements.md');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents.replace(/\r\n/g, '\n'), 'utf8');
}
