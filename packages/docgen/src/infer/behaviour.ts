import type { GenerationContext } from '../types/core.js';
import { note, renderFrontMatter, section, sourceLink, warning } from '../render/markdown.js';
import { compareStrings } from '../util/sort.js';
import type { Answer, SurfaceAnswers } from '../questions/store.js';
import type { Claim, FeatureCard, Unknown } from './types.js';

/**
 * Behaviour pages: what each surface actually does.
 *
 * This is the page QA reads, and it is the one place in docgen where unverified
 * content is published. So the trust lane of every line is visible on the line
 * itself, never inferred from where it sits on the page:
 *
 *   - a model's claim is `inferred`, and carries a link to the code it cites
 *   - a developer's recorded answer is `verified`, and names who said it
 *   - anything still open is `unknown`, and shows the command that closes it
 *
 * The three are never blended into a paragraph. A reader who skims must still
 * come away knowing which sentences were checked by a human.
 */

export const BEHAVIOUR_DIR = 'behaviour';

/** Badges. Terse enough to sit inline without drowning the sentence. */
const INFERRED = '`inferred`';
const VERIFIED = '`verified`';
const UNKNOWN = '`unknown`';

export interface BehaviourPageArgs {
  readonly card: FeatureCard;
  readonly answers: SurfaceAnswers | undefined;
  readonly context: GenerationContext;
  /** Output directory, repo-relative POSIX, e.g. 'docs/generated'. */
  readonly outDir: string;
}

export function renderBehaviourPage(args: BehaviourPageArgs): string {
  const { card, answers, context } = args;
  // Pages live one level deeper than the rest, so source links need the extra hop.
  const outDir = `${args.outDir}/${BEHAVIOUR_DIR}`;
  const recorded = answers?.answers ?? [];
  const answeredIds = new Set(recorded.map((answer) => answer.questionId));
  const open = card.body.unknowns.filter((unknown) => !answeredIds.has(unknown.id));

  const parts: string[] = [
    renderFrontMatter({
      title: card.title,
      // The page as a whole is inferred even when some answers are verified:
      // claiming otherwise at file level would overstate the weaker content.
      confidence: 'inferred',
      context,
      regenerateWith: 'docgen bootstrap',
    }),
    `# ${card.title}\n\n`,
    renderHeader(card, recorded.length, open.length),
    section('Summary', `${INFERRED} ${renderClaimBody(card.body.summary, outDir)}`),
  ];

  if (recorded.length > 0) {
    parts.push(section(`Confirmed by a developer (${recorded.length})`, renderAnswers(recorded)));
  }

  parts.push(
    renderClaimSection('What a user can observe', card.body.userVisibleBehaviour, outDir),
    renderClaimSection('States', card.body.states, outDir),
    renderClaimSection('Edge cases', card.body.edgeCases, outDir),
    renderOpenQuestions(open, card.slug),
  );

  return parts.join('');
}

function renderHeader(card: FeatureCard, answered: number, open: number): string {
  const lines = [
    'Everything below marked `inferred` was written by a language model reading the code.',
    'It has not been checked by anyone. Treat it as a starting point for a conversation,',
    'not as a specification.',
  ];

  if (open > 0) {
    lines.push(
      '',
      `**${open} question${open === 1 ? '' : 's'} on this surface ${
        open === 1 ? 'is' : 'are'
      } still unanswered.** Until they are, this page describes what the code`,
      'appears to do — not what it is supposed to do.',
    );
  }

  const meta = [
    `- Surface: \`${card.surfaceId}\` (${card.kind})`,
    `- Inferred by: \`${card.producedBy}\`, prompt \`${card.promptVersion}\``,
    `- Answered questions: ${answered} · open: ${open}`,
    '',
  ].join('\n');

  return `${warning(lines)}${meta}\n`;
}

/**
 * One claim, with its citations.
 *
 * The evidence links are not decoration: an inferred claim is only useful if
 * the reader can check it in one click, and a claim whose links do not support
 * it is how a wrong claim gets caught.
 */
function renderClaimBody(claim: Claim, outDir: string): string {
  const citations = claim.evidence
    .map((evidence) =>
      sourceLink(
        { file: evidence.file, ...(evidence.line === undefined ? {} : { line: evidence.line }) },
        outDir,
      ),
    )
    .join(', ');

  return `${claim.text}\n\n  <sub>${citations}</sub>\n`;
}

function renderClaimSection(title: string, claims: readonly Claim[], outDir: string): string {
  if (claims.length === 0) {
    // An empty section is stated rather than omitted: "the model found none" and
    // "nobody looked" are different, and only one of them is true here.
    return section(title, `_The model identified none for this surface._\n`);
  }

  return section(
    title,
    claims.map((claim) => `- ${INFERRED} ${renderClaimBody(claim, outDir)}`).join('\n'),
  );
}

/** Recorded answers — the only `verified` content on the page. */
function renderAnswers(answers: readonly Answer[]): string {
  const sorted = [...answers].sort((a, b) => compareStrings(a.questionId, b.questionId));

  return `${note([
    'These were answered by a developer and are recorded in `docs/.answers/`.',
    'They override anything inferred above, and they survive regeneration.',
  ])}${sorted
    .map((answer) => {
      const attribution = `<sub>— ${answer.answeredBy}${
        answer.answeredAt.length > 0 ? `, ${answer.answeredAt.slice(0, 10)}` : ''
      }</sub>`;
      const detail = answer.note === undefined ? '' : `\n\n  ${answer.note}\n`;
      return `- ${VERIFIED} **${answer.question || answer.questionId}**\n\n  ${answer.answer}\n${detail}\n  ${attribution}\n`;
    })
    .join('\n')}`;
}

/**
 * The open queue, rendered so answering is the path of least resistance.
 *
 * Each question carries the exact command that closes it, because the gap
 * between "I know the answer" and "the answer is recorded" is where every
 * documentation effort dies.
 */
function renderOpenQuestions(unknowns: readonly Unknown[], slug: string): string {
  if (unknowns.length === 0) {
    return section(
      'Open questions',
      '_None. Every question raised for this surface has been answered._\n',
    );
  }

  const body = unknowns
    .map((unknown) => {
      const options =
        unknown.options.length === 0
          ? ''
          : `\n${unknown.options
              .map((option, index) => `  ${index + 1}. ${option}`)
              .join('\n')}\n`;

      const command =
        unknown.options.length === 0
          ? `docgen answer ${slug} ${unknown.id} "your answer"`
          : `docgen answer ${slug} ${unknown.id} <number>`;

      return (
        `### ${UNKNOWN} ${unknown.question}\n\n` +
        `${unknown.why}\n${options}\n` +
        `\`\`\`sh\n${command}\n\`\`\`\n`
      );
    })
    .join('\n');

  return section(
    `Open questions (${unknowns.length})`,
    `${note([
      'These are things the model could not determine from the code. They are recorded as',
      'questions rather than guessed at. Answering one records it as ground truth and',
      'promotes it from a question to a verified statement.',
    ])}${body}`,
  );
}

export interface BehaviourIndexArgs {
  readonly cards: readonly FeatureCard[];
  readonly answers: ReadonlyMap<string, SurfaceAnswers>;
  readonly context: GenerationContext;
  readonly outDir: string;
}

export function renderBehaviourIndex(args: BehaviourIndexArgs): string {
  const rows = [...args.cards].sort((a, b) => compareStrings(a.slug, b.slug));

  const totals = rows.reduce(
    (accumulator, card) => {
      const answered = new Set((args.answers.get(card.surfaceId)?.answers ?? []).map((a) => a.questionId));
      const open = card.body.unknowns.filter((unknown) => !answered.has(unknown.id)).length;
      return {
        answered: accumulator.answered + answered.size,
        open: accumulator.open + open,
      };
    },
    { answered: 0, open: 0 },
  );

  const table =
    rows.length === 0
      ? '_No surfaces have been described yet. Run `docgen bootstrap`._\n'
      : [
          '| Surface | Kind | Answered | Open questions |',
          '| --- | --- | --- | --- |',
          ...rows.map((card) => {
            const answered = new Set(
              (args.answers.get(card.surfaceId)?.answers ?? []).map((a) => a.questionId),
            );
            const open = card.body.unknowns.filter((unknown) => !answered.has(unknown.id)).length;
            return `| [${card.title}](${BEHAVIOUR_DIR}/${card.slug}.md) | ${card.kind} | ${answered.size} | ${open} |`;
          }),
          '',
        ].join('\n');

  return [
    renderFrontMatter({
      title: 'Behaviour',
      confidence: 'inferred',
      context: args.context,
      regenerateWith: 'docgen bootstrap',
    }),
    '# Behaviour\n\n',
    warning([
      'These pages are model-inferred and unverified, except where a line carries a verified badge.',
      'Do not treat them as a specification until the open questions below are answered.',
    ]),
    `${totals.open} open question${totals.open === 1 ? '' : 's'} across ${rows.length} surface${
      rows.length === 1 ? '' : 's'
    }; ${totals.answered} answered.\n\n`,
    table,
    '\n',
    note([
      'Run `docgen ask --mine` to see the questions on code you last touched,',
      'and `docgen answer <surface> <question-id> <answer>` to record one.',
    ]),
  ].join('');
}
