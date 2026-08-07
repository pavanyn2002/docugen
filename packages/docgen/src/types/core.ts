/**
 * Core domain vocabulary. This module has no imports by design: everything else
 * depends on it, so it must stay dependency-free to avoid cycles.
 */

/** The six Phase 0 static extractors. */
export const EXTRACTOR_IDS = ['routes', 'schema', 'deps', 'endpoints', 'jobs', 'config'] as const;
export type ExtractorId = (typeof EXTRACTOR_IDS)[number];

/**
 * Trust lane — SPEC section 3. Applies to a whole rendered file or section.
 *
 * Phase 0 only ever produces `verified`, because every Phase 0 statement is
 * derived from a parser reading real code. `inferred` and `unknown` exist here
 * so the renderer's badge logic is written once, correctly, before Phase 1 adds
 * an LLM that can produce them.
 */
export type TrustLane = 'verified' | 'inferred' | 'unknown';

/**
 * How a single entry was obtained. Distinct from TrustLane: an entry can be
 * `verified` (a parser read it from code) while still being `regex`-derived and
 * therefore lower certainty than an AST read.
 *
 * SPEC 6.1: regex fallback must mark the entry low-certainty.
 */
export type ExtractionMethod =
  /** Language AST via a real parser. Highest certainty. */
  | 'ast'
  /** A framework/build manifest the framework itself produces. */
  | 'manifest'
  /** An ORM's own schema representation (Prisma DMMF, Mongoose schema, etc). */
  | 'schema'
  /** A structured config or declaration file (package.json, .env, yaml). */
  | 'config'
  /** Last-resort textual match. Always low certainty — see SPEC 6.1. */
  | 'regex';

/** Certainty of a single entry, derived from its ExtractionMethod. */
export type Certainty = 'high' | 'low';

/** Certainty implied by each extraction method. Regex is never high. */
export const CERTAINTY_BY_METHOD: Readonly<Record<ExtractionMethod, Certainty>> = Object.freeze({
  ast: 'high',
  manifest: 'high',
  schema: 'high',
  config: 'high',
  regex: 'low',
});

/**
 * A pointer into the target repo. `file` is always repo-relative and uses
 * POSIX separators, so output is identical on Windows and Linux.
 */
export interface SourceRef {
  readonly file: string;
  /** 1-based. Omitted when the parser could not attribute a line. */
  readonly line?: number;
  /** 1-based. */
  readonly column?: number;
}

/**
 * Something an extractor could not determine.
 *
 * SPEC rule 5: a missing field is omitted and recorded here. It is never filled
 * with a plausible value. Gaps are the honest output of a failed inference and
 * become Phase 1 questions.
 */
/** What produced a Gap. The surface chunker can fail to place things too. */
export type GapSource = ExtractorId | 'surface';

export interface Gap {
  readonly extractor: GapSource;
  /** Stable machine-readable code, e.g. 'unresolved-handler'. Never prose. */
  readonly kind: string;
  /** Human-readable explanation of what could not be determined, and why. */
  readonly message: string;
  readonly source?: SourceRef;
}

/** A technology an extractor looked for and did not find. Not an error. */
export interface Skip {
  readonly extractor: ExtractorId;
  /** Stable code, e.g. 'no-prisma-schema'. */
  readonly kind: string;
  readonly message: string;
}

/** Base fields shared by every extracted entry. */
export interface EntryBase {
  /**
   * Stable identity for this entry, unique within its extractor. Used for
   * sorting, cross-referencing, and Phase 4 change detection. Must be derived
   * only from the entry's own content so it survives file moves where possible.
   */
  readonly id: string;
  readonly source: SourceRef;
  /** Named `extractionMethod`, not `method`, so it cannot collide with an HTTP verb. */
  readonly extractionMethod: ExtractionMethod;
  readonly certainty: Certainty;
}

/**
 * The uniform return of every extractor.
 *
 * SPEC 6.1: extractors are pure functions of the project root that degrade
 * gracefully — an inapplicable technology yields `applicable: false` and an
 * empty entry list, never a throw.
 */
export interface ExtractResult<TEntry extends EntryBase = EntryBase> {
  readonly extractor: ExtractorId;
  /** False when the target repo does not use this technology at all. */
  readonly applicable: boolean;
  /** Detected frameworks/tools that produced these entries, e.g. ['next-app-router']. */
  readonly detected: readonly string[];
  readonly entries: readonly TEntry[];
  readonly gaps: readonly Gap[];
  readonly skips: readonly Skip[];
  /**
   * Diagnostics for the console run report only. Never rendered into a file —
   * it would break byte-determinism.
   */
  readonly durationMs: number;
}

/** Provenance stamped into the front matter of every generated file. */
export interface GenerationContext {
  readonly engineVersion: string;
  /** Full git SHA of the target repo, or undefined when not a git checkout. */
  readonly sourceCommit?: string;
  /**
   * ISO-8601 date of the source commit, rendered only into README.md.
   *
   * Deliberately the commit date rather than the run time: a wall-clock stamp
   * changes on every invocation and would produce a README diff even when the
   * repository has not moved. Absent outside a git checkout, where there is no
   * commit to date the documentation against.
   */
  readonly generatedAt?: string;
}
