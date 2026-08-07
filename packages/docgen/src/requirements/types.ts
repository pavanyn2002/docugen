/**
 * What an answered question becomes.
 *
 * An answer on its own is not a requirement. "The user must resubmit after a
 * timeout" could be the intended design or a defect nobody has filed, and those
 * lead to opposite actions: one becomes a test case, the other becomes a bug.
 * Triage is where a developer says which, and it is the only place that
 * distinction can be made — no parser and no model can tell intent from
 * accident by reading the code.
 */

export const REQUIREMENT_KINDS = ['requirement', 'bug', 'decision', 'context'] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

/** Human-facing labels, used in prompts and in the rendered page. */
export const KIND_LABELS: Readonly<Record<RequirementKind, string>> = Object.freeze({
  requirement: 'Intended behaviour',
  bug: 'Defect',
  decision: 'Technical decision',
  context: 'Context only',
});

export const KIND_PREFIXES: Readonly<Record<RequirementKind, string>> = Object.freeze({
  requirement: 'REQ',
  bug: 'BUG',
  decision: 'ADR',
  context: 'CTX',
});

/**
 * `confirmed` is the state a developer put it in. `disputed` and `superseded`
 * exist so a wrong entry can be corrected without deleting the history a test
 * case may already be traced to.
 */
export const REQUIREMENT_STATUSES = ['confirmed', 'disputed', 'superseded'] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export interface Requirement {
  /** Stable, quotable, and unique within the repo, e.g. 'REQ-checkout-01'. */
  readonly id: string;
  readonly kind: RequirementKind;
  readonly status: RequirementStatus;
  /** The question that produced it, verbatim. Never a paraphrase. */
  readonly title: string;
  /** What the developer said is true. */
  readonly statement: string;
  /** Links back to the answer, so the chain to the code is never broken. */
  readonly questionId: string;
  readonly surfaceId: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly note?: string;
}

export interface SurfaceRequirements {
  readonly surfaceId: string;
  readonly slug: string;
  readonly requirements: readonly Requirement[];
}
