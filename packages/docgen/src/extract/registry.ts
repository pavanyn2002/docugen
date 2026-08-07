import type { ExtractorId } from '../types/core.js';
import type { Extractor } from './types.js';
import { routesExtractor } from './routes/index.js';
import { schemaExtractor } from './schema/index.js';
import { endpointsExtractor } from './endpoints/index.js';

/**
 * The extractor registry.
 *
 * Extractors are added here one at a time as they are implemented and tested
 * (SPEC rule 2), so `docgen extract` reports honestly which are missing rather
 * than implying it scanned for something it cannot yet parse.
 */
const REGISTERED: readonly Extractor[] = Object.freeze([
  routesExtractor as Extractor,
  schemaExtractor as Extractor,
  endpointsExtractor as Extractor,
]);

export function getExtractors(): readonly Extractor[] {
  return REGISTERED;
}

export function getRegisteredIds(): readonly ExtractorId[] {
  return REGISTERED.map((extractor) => extractor.id);
}

/** Extractor ids named in the SPEC but not yet implemented. */
export function getUnimplementedIds(all: readonly ExtractorId[]): readonly ExtractorId[] {
  const registered = new Set(getRegisteredIds());
  return all.filter((id) => !registered.has(id));
}
