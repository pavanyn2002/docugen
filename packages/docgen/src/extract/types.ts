import type { EntryBase, ExtractResult, ExtractorId, Skip } from '../types/core.js';
import type { ResolvedConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';

/**
 * Everything an extractor is allowed to see.
 *
 * SPEC 6.1 specifies `(projectRoot: string) => Promise<ExtractResult>`. This
 * widens the argument to a context object carrying the resolved config and a
 * logger; `root` is still the only filesystem input. Without the config an
 * extractor cannot honour the user's exclude globs, which would make output
 * wrong on repos with vendored code.
 */
export interface ExtractorContext {
  /** Absolute path to the target repo root. */
  readonly root: string;
  readonly config: ResolvedConfig;
  readonly logger: Logger;
}

export interface Extractor<TEntry extends EntryBase = EntryBase> {
  readonly id: ExtractorId;
  /** Human-readable name for the run report. */
  readonly title: string;
  /**
   * Must never throw for absent technology — return an inapplicable result
   * with a Skip instead. Throwing is reserved for malformed input the user
   * needs to fix (SPEC rule 6).
   */
  run(context: ExtractorContext): Promise<ExtractResult<TEntry>>;
}

/** Build the "this technology isn't here" result. Not an error. */
export function inapplicable<TEntry extends EntryBase>(
  extractor: ExtractorId,
  skips: readonly Skip[],
  durationMs = 0,
): ExtractResult<TEntry> {
  return {
    extractor,
    applicable: false,
    detected: [],
    entries: [],
    gaps: [],
    skips,
    durationMs,
  };
}

export function skip(extractor: ExtractorId, kind: string, message: string): Skip {
  return { extractor, kind, message };
}
