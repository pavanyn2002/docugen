import type { FeatureCard } from '../infer/types.js';
import type { Requirement, SurfaceRequirements } from '../requirements/types.js';
import { compareStrings } from '../util/sort.js';
import type { TestReference } from './scan.js';

/**
 * The traceability matrix: requirement → surface → test.
 *
 * The value of this is not the table. It is the three gaps the table exposes,
 * each of which is a different kind of problem and needs a different person to
 * act on it (SPEC 8, phase 3):
 *
 *   - a requirement with no test is untested behaviour someone agreed to
 *   - a test citing an id that does not exist is a broken link, usually a typo
 *     or a requirement deleted out from under it
 *   - a surface described only by the model, with nothing confirmed, is
 *     behaviour that maps to neither — nobody has agreed what it should do,
 *     and nothing checks that it does
 */

/** Only these produce a test case. A decision or a note is not testable. */
const TESTABLE_KINDS = new Set(['requirement', 'bug']);

export interface TraceRow {
  readonly requirement: Requirement;
  /** Test-case id, mechanically derived. Present only for testable kinds. */
  readonly testCaseId?: string;
  readonly references: readonly TestReference[];
}

export interface UntracedSurface {
  readonly surfaceId: string;
  readonly slug: string;
  readonly title: string;
  /** Inferred claims on it, so the size of the gap is visible. */
  readonly claimCount: number;
  readonly openQuestions: number;
}

export interface TraceMatrix {
  readonly rows: readonly TraceRow[];
  /** Testable requirements with no test citing them. */
  readonly untested: readonly TraceRow[];
  /** Ids cited by tests that match no requirement on record. */
  readonly danglingReferences: readonly TestReference[];
  /** Surfaces with inferred behaviour but nothing confirmed. */
  readonly untracedSurfaces: readonly UntracedSurface[];
  readonly testedCount: number;
  readonly testableCount: number;
}

export function buildMatrix(args: {
  requirements: ReadonlyMap<string, SurfaceRequirements>;
  cards: readonly FeatureCard[];
  references: readonly TestReference[];
  answers: ReadonlyMap<string, { readonly answers: readonly { readonly questionId: string }[] }>;
}): TraceMatrix {
  const all = [...args.requirements.values()]
    .flatMap((surface) => surface.requirements)
    .sort((a, b) => compareStrings(a.id, b.id));

  const byId = new Map(all.map((requirement) => [requirement.id, requirement]));

  const referencesById = new Map<string, TestReference[]>();
  for (const reference of args.references) {
    const list = referencesById.get(reference.id);
    if (list === undefined) referencesById.set(reference.id, [reference]);
    else list.push(reference);
  }

  const rows: TraceRow[] = all.map((requirement) => {
    const references = referencesById.get(requirement.id) ?? [];
    return {
      requirement,
      ...(TESTABLE_KINDS.has(requirement.kind) ? { testCaseId: testCaseIdFor(requirement) } : {}),
      references,
    };
  });

  const testable = rows.filter((row) => row.testCaseId !== undefined);

  // A superseded requirement is deliberately excluded from the untested list:
  // it has been replaced, and demanding a test for it would be demanding a test
  // for behaviour the team has already moved on from.
  const untested = testable.filter(
    (row) => row.references.length === 0 && row.requirement.status !== 'superseded',
  );

  const dangling = args.references
    .filter((reference) => !byId.has(reference.id))
    .sort((a, b) => compareStrings(a.id, b.id) || compareStrings(a.file, b.file) || a.line - b.line);

  const surfacesWithRequirements = new Set(all.map((requirement) => requirement.surfaceId));
  const untracedSurfaces: UntracedSurface[] = args.cards
    .filter((card) => !surfacesWithRequirements.has(card.surfaceId))
    .map((card) => {
      const answered = new Set(
        (args.answers.get(card.surfaceId)?.answers ?? []).map((answer) => answer.questionId),
      );
      return {
        surfaceId: card.surfaceId,
        slug: card.slug,
        title: card.title,
        claimCount:
          1 +
          card.body.userVisibleBehaviour.length +
          card.body.states.length +
          card.body.edgeCases.length,
        openQuestions: card.body.unknowns.filter((unknown) => !answered.has(unknown.id)).length,
      };
    })
    .sort((a, b) => compareStrings(a.slug, b.slug));

  return {
    rows,
    untested,
    danglingReferences: dangling,
    untracedSurfaces,
    testedCount: testable.length - untested.length,
    testableCount: testable.length,
  };
}

/**
 * The test case for a requirement.
 *
 * Derived from the requirement id rather than numbered separately, so the two
 * can never drift apart and either one can be found from the other. The kind
 * prefix stays in: `REQ-checkout-01` and `BUG-checkout-01` are different
 * requirements, and their test cases must not collide.
 */
export function testCaseIdFor(requirement: Requirement): string {
  return `TC-${requirement.id}`;
}
