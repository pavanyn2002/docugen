/**
 * What a coding agent is told about docgen.
 *
 * This is the delivery mechanism for the whole question loop. Developers will
 * not visit a dashboard and will not write documentation by hand, but they are
 * already talking to an agent inside the repository — so the questions have to
 * arrive there, in the tool they already have open.
 *
 * The instructions are written to be acted on, not admired. They say when to
 * check, what command to run, and what to do with the answer. Everything else
 * is noise that makes an agent less likely to follow any of it.
 */

export interface InstructionArgs {
  /** How docgen is invoked in this repo, e.g. 'npx docgen' or 'docgen'. */
  readonly invocation: string;
}

export function renderAgentInstructions(args: InstructionArgs): string {
  const run = args.invocation;

  return [
    '## Documentation questions (docgen)',
    '',
    'This repository documents itself with docgen. Some of that documentation is inferred',
    'by a model and marked `inferred`; it becomes `verified` only when a developer answers',
    'the question behind it. Answering is the entire point — an unanswered question means QA',
    'has no way to tell a bug from intended behaviour.',
    '',
    '**When to raise this with the developer:**',
    '',
    `- After finishing work on a file, run \`${run} ask --mine\` and surface anything it returns.`,
    '- When the developer asks about behaviour that only they would know, and you would',
    '  otherwise guess, check whether it is already an open question.',
    '- Never answer these questions yourself. An answer recorded under a developer\'s name',
    '  that the developer did not give is worse than no answer, because it will be trusted.',
    '',
    '**How to record an answer:**',
    '',
    '```sh',
    `${run} ask --mine              # questions on code this developer last touched`,
    `${run} ask --json              # the full queue, machine-readable`,
    `${run} answer <surface> <question-id> <answer>`,
    '```',
    '',
    'The answer may be free text, or the number of one of the offered options. Recording it',
    'writes to `docs/.answers/` and updates the generated documentation immediately.',
    '',
    '**What not to do:**',
    '',
    '- Do not hand-edit anything under `docs/generated/` or `docs/.cards/`. Both are',
    '  regenerated and your changes will be lost.',
    '- Do not treat an `inferred` claim as a specification. It has not been checked.',
    `- Do not run \`${run} bootstrap\` without asking — it calls a model and costs money.`,
  ].join('\n');
}

/**
 * Cursor rules need YAML front matter to be applied automatically.
 * `alwaysApply` is what makes the rule visible without the developer asking.
 */
export function renderCursorRule(args: InstructionArgs): string {
  return [
    '---',
    'description: Documentation questions raised by docgen',
    'alwaysApply: true',
    '---',
    '',
    renderAgentInstructions(args),
    '',
  ].join('\n');
}
