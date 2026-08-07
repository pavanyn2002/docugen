import { DocgenError } from '../util/errors.js';

/** Phase each not-yet-built command belongs to, for an honest error message. */
export const PLANNED_COMMANDS: Readonly<Record<string, { phase: string; summary: string }>> = Object.freeze({
  triage: { phase: 'Phase 2', summary: 'work the unknown queue interactively into requirements' },
  sync: { phase: 'Phase 4', summary: 'regenerate only the surfaces a diff touched' },
  check: { phase: 'Phase 4', summary: 'CI gate that fails on documentation drift' },
  init: { phase: 'Phase 4', summary: 'install editor and CI adapters into a repo' },
});

/**
 * Fail a planned-but-unbuilt command loudly.
 *
 * These exist now so the command surface is fixed early (SPEC section 5) and
 * adapters can be written against a stable CLI. They exit non-zero: a CI job
 * that calls `docgen check` must not pass just because the gate isn't built.
 */
export function runStub(name: keyof typeof PLANNED_COMMANDS | string): never {
  const planned = PLANNED_COMMANDS[name];
  throw new DocgenError({
    code: 'not-implemented',
    message: planned
      ? `\`docgen ${name}\` is not implemented yet — it will ${planned.summary} (${planned.phase}).`
      : `\`docgen ${name}\` is not implemented yet.`,
    remedy: 'Phase 0 implements `docgen extract` and `docgen report`. Run `docgen --help` to see what is available.',
  });
}
