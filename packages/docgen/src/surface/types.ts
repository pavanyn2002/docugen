import type { Gap } from '../types/core.js';

/**
 * A surface is the unit a QA person would ask a question about: one screen, one
 * API endpoint group, or one background job (SPEC section 4). Not one file, not
 * one function.
 *
 * Surfaces are the chunking unit for Phase 1 inference and the key that Phase 1
 * answers are filed under, so their identity must stay stable across runs.
 */
export type SurfaceKind = 'screen' | 'endpoint-group' | 'job';

export interface Surface {
  /** Stable identity, e.g. 'screen:/orders/[id]', 'api:orders', 'job:reindex'. */
  readonly id: string;
  /** Filesystem-safe form of `id`, unique within the set. */
  readonly slug: string;
  readonly kind: SurfaceKind;
  /**
   * Display label. Derived mechanically from the path or name — never an
   * interpretation of what the surface does. Naming '/orders/[id]' as
   * "Order detail" would be a behavioural claim, and behavioural claims are
   * Phase 1's job, badged.
   */
  readonly title: string;
  /** Ids of RouteEntries that make up this surface's screen. */
  readonly routes: readonly string[];
  /** Ids of RouteEntries that support it (layouts, templates, error boundaries). */
  readonly supportingRoutes: readonly string[];
  readonly endpoints: readonly string[];
  readonly jobs: readonly string[];
  /** Every file backing this surface. Sorted, deduped, repo-relative POSIX. */
  readonly sourceFiles: readonly string[];
  /** Whether the default heuristics produced this surface or config forced it. */
  readonly origin: 'derived' | 'override';
}

/** An entry the chunker could not place. Recorded, never silently dropped. */
export interface UnassignedEntry {
  readonly entryId: string;
  readonly extractor: 'routes' | 'endpoints' | 'jobs';
  /** Stable code, e.g. 'supporting-route-unattached'. */
  readonly reason: string;
  readonly detail: string;
}

export interface SurfaceSet {
  /** Sorted by kind then id, so output is byte-identical across runs. */
  readonly surfaces: readonly Surface[];
  readonly unassigned: readonly UnassignedEntry[];
  readonly gaps: readonly Gap[];
  /**
   * Chunking decisions a reader needs to interpret the surface list — notably
   * an auto-detected service mount prefix, which changes every endpoint
   * surface's id. Rendered so the grouping is never invisible.
   */
  readonly notes: readonly string[];
}
