import type { EntryBase, ExtractResult, ExtractorId, Skip } from '../types/core.js';
import type { ResolvedConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import type { Workspace } from '../detect/workspaces.js';

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
  readonly workspaces?: readonly Workspace[];
  /** Repo-relative POSIX files whose graph partitions are being rebuilt. */
  readonly partitionFiles?: ReadonlySet<string>;
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

function touchesPartition(value: unknown, files: ReadonlySet<string>, seen: Set<object>): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if ('file' in value && typeof value.file === 'string' && files.has(value.file.replaceAll('\\', '/'))) {
    return true;
  }
  if (Array.isArray(value)) return value.some((item) => touchesPartition(item, files, seen));
  return Object.values(value).some((item) => touchesPartition(item, files, seen));
}

/** Keep only extractor evidence that can contribute to the requested file partitions. */
export function scopeExtractResult<TEntry extends EntryBase>(
  result: ExtractResult<TEntry>,
  files: ReadonlySet<string> | undefined,
): ExtractResult<TEntry> {
  if (files === undefined) return result;
  return {
    ...result,
    entries: result.entries.filter((entry) => touchesPartition(entry, files, new Set())),
    // Source-less gaps belong to the global partition, which every scoped run rebuilds.
    gaps: result.gaps.filter(
      (gap) => gap.source === undefined || files.has(gap.source.file.replaceAll('\\', '/')),
    ),
  };
}
