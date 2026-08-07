import type { GenerationContext } from '../types/core.js';
import { note, renderFrontMatter, section } from '../render/markdown.js';
import { KIND_LABELS } from '../requirements/types.js';
import type { TraceMatrix, TraceRow } from './matrix.js';

/**
 * Test cases and the traceability matrix.
 *
 * A test case here states what must be true and where that was decided. It does
 * **not** invent steps: nobody told docgen how to reach the state being
 * described, and a plausible-looking set of steps that does not match the real
 * UI is worse than an empty field, because a tester will follow it and conclude
 * the feature is broken.
 */

export interface TracePageArgs {
  readonly matrix: TraceMatrix;
  readonly context: GenerationContext;
  readonly outDir: string;
}

export function renderTestCasesPage(args: TracePageArgs): string {
  const testable = args.matrix.rows.filter((row) => row.testCaseId !== undefined);

  let body = `${renderFrontMatter({
    title: 'Test cases',
    // Derived mechanically from requirements a developer confirmed. No model
    // touched any of it.
    confidence: 'verified',
    context: args.context,
    regenerateWith: 'docgen trace',
  })}# Test cases\n\n`;

  body +=
    'One case per confirmed requirement or defect. Each states what must be true and links to ' +
    'the requirement it came from. Steps are deliberately left blank — docgen was never told ' +
    'how to reach these states, and invented steps would send a tester down a path that does ' +
    'not exist.\n\n';

  if (testable.length === 0) {
    body += note([
      'No testable requirements have been recorded yet. Run `docgen triage` and classify',
      'answers as intended behaviour or defects; every one of those becomes a case here.',
    ]);
    return body;
  }

  body += section(
    'How to link a test',
    'Put the requirement id in the test name or a comment. `docgen trace` finds it there and ' +
      'nothing else has to be maintained:\n\n' +
      '```ts\n' +
      "it('REQ-checkout-01: the user must resubmit after a provider timeout', () => {\n" +
      '  // …\n' +
      '});\n' +
      '```\n',
  );

  for (const row of testable) {
    body += renderTestCase(row);
  }

  return body;
}

function renderTestCase(row: TraceRow): string {
  const { requirement } = row;
  const covered =
    row.references.length === 0
      ? '_Not covered by any test._'
      : row.references
          .map((reference) => `\`${reference.file}:${reference.line}\``)
          .join(', ');

  return section(
    `${row.testCaseId ?? requirement.id}`,
    [
      `**Verify:** ${requirement.statement}`,
      '',
      `**Because:** ${requirement.title}`,
      '',
      `| | |`,
      `| --- | --- |`,
      `| Requirement | \`${requirement.id}\` (${KIND_LABELS[requirement.kind]}) |`,
      `| Surface | \`${requirement.surfaceId}\` |`,
      `| Confirmed by | ${requirement.recordedBy}${
        requirement.recordedAt.length > 0 ? `, ${requirement.recordedAt.slice(0, 10)}` : ''
      } |`,
      `| Automated by | ${covered} |`,
      '',
      '**Steps:** _to be written by whoever knows how to reach this state._',
      '',
    ].join('\n'),
  );
}

export function renderTraceabilityPage(args: TracePageArgs): string {
  const { matrix } = args;

  let body = `${renderFrontMatter({
    title: 'Traceability',
    confidence: 'verified',
    context: args.context,
    regenerateWith: 'docgen trace',
  })}# Traceability\n\n`;

  const percent =
    matrix.testableCount === 0
      ? 0
      : Math.round((matrix.testedCount / matrix.testableCount) * 100);

  body +=
    `${matrix.testedCount} of ${matrix.testableCount} testable requirements are cited by at ` +
    `least one test (${percent}%).\n\n`;

  body += section(
    'Matrix',
    matrix.rows.length === 0
      ? '_Nothing has been triaged yet, so there is nothing to trace._\n'
      : [
          '| Requirement | Kind | Test case | Covered by |',
          '| --- | --- | --- | --- |',
          ...matrix.rows.map((row) => {
            const covered =
              row.references.length === 0
                ? row.testCaseId === undefined
                  ? '—'
                  : '**none**'
                : row.references
                    .map((reference) => `\`${reference.file}:${reference.line}\``)
                    .join('<br>');
            return `| \`${row.requirement.id}\` | ${KIND_LABELS[row.requirement.kind]} | ${
              row.testCaseId === undefined ? '—' : `\`${row.testCaseId}\``
            } | ${covered} |`;
          }),
          '',
        ].join('\n'),
  );

  body += section(
    `Requirements with no test (${matrix.untested.length})`,
    matrix.untested.length === 0
      ? '_None. Every confirmed requirement is cited by at least one test._\n'
      : [
          'Behaviour someone agreed to, that nothing checks.',
          '',
          ...matrix.untested.map(
            (row) => `- \`${row.requirement.id}\` — ${row.requirement.statement}`,
          ),
          '',
        ].join('\n'),
  );

  body += section(
    `Tests citing an unknown requirement (${matrix.danglingReferences.length})`,
    matrix.danglingReferences.length === 0
      ? '_None. Every id cited by a test exists._\n'
      : [
          'A broken link — usually a typo, or a requirement removed while the test kept citing it.',
          'These tests are not counted as covering anything.',
          '',
          ...matrix.danglingReferences.map(
            (reference) => `- \`${reference.id}\` cited at \`${reference.file}:${reference.line}\``,
          ),
          '',
        ].join('\n'),
  );

  body += section(
    `Behaviour mapping to neither (${matrix.untracedSurfaces.length})`,
    matrix.untracedSurfaces.length === 0
      ? '_None. Every described surface has at least one confirmed requirement._\n'
      : [
          'Surfaces the model described but nobody has confirmed anything about. There is no',
          'requirement to test against and no test that could fail — the largest gap of the three,',
          'and the least visible.',
          '',
          '| Surface | Inferred claims | Open questions |',
          '| --- | --- | --- |',
          ...matrix.untracedSurfaces.map(
            (surface) =>
              `| [${surface.title}](behaviour/${surface.slug}.md) | ${surface.claimCount} | ${surface.openQuestions} |`,
          ),
          '',
        ].join('\n'),
  );

  return body;
}

/** Counts for the command's own report and for `docgen status`. */
export function summariseMatrix(matrix: TraceMatrix): {
  readonly testable: number;
  readonly tested: number;
  readonly untested: number;
  readonly dangling: number;
  readonly untracedSurfaces: number;
} {
  return {
    testable: matrix.testableCount,
    tested: matrix.testedCount,
    untested: matrix.untested.length,
    dangling: matrix.danglingReferences.length,
    untracedSurfaces: matrix.untracedSurfaces.length,
  };
}

