import type { Gap } from '../../types/core.js';
import type { SchemaEntry } from '../../types/entries.js';

/**
 * A schema source. Each ORM, DSL, or migration format is one provider.
 *
 * Providers are independent and additive: a repo using Prisma for one service
 * and raw SQL migrations for another yields both. A provider that finds nothing
 * returns empty — absence is not an error (SPEC rule 6).
 */
export interface SchemaProvider {
  readonly id: string;
  readonly name: string;
  run(context: SchemaProviderContext): Promise<SchemaProviderResult>;
}

export interface SchemaProviderContext {
  readonly root: string;
  readonly exclude: readonly string[];
}

export interface SchemaProviderResult {
  readonly entries: readonly SchemaEntry[];
  readonly gaps: readonly Gap[];
}

export const EMPTY_RESULT: SchemaProviderResult = Object.freeze({ entries: [], gaps: [] });
