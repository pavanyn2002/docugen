import type { InstructionArgs } from './instructions.js';

/** A concise, portable Agent Skills document installed for each supported host. */
export function renderDocgenSkill(args: InstructionArgs): string {
  const run = args.invocation;
  return `---
name: govern-documentation
description: Keep code evidence, feature plans, generated documentation, questions, and tester handoffs current. Use whenever planning, implementing, reviewing, testing, or handing off a code change in a repository managed by docgen.
---

# Govern documentation

1. Before planning or editing, run \`${run} session start --json\`. Read active plans and open questions.
2. After each coherent code edit, run \`${run} session after-edit --json\`. Use the impact result to update the relevant feature or plan record.
3. Never hand-edit \`docs/generated/\`, \`docs/.cards/\`, or evidence indexes. Never invent a developer answer.
4. Before handing work back, run \`${run} session end --json\`. Resolve any failure instead of claiming the handoff is complete.
5. Run \`${run} bootstrap\` only with developer approval because it invokes a model. Indexing, sync, impact, and checks are local and deterministic.
`;
}

export const GENERIC_SKILL_PATH = '.agents/skills/govern-documentation/SKILL.md';
export const CLAUDE_SKILL_PATH = '.claude/skills/govern-documentation/SKILL.md';
