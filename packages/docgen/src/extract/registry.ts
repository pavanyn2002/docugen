import type { ExtractorId } from '../types/core.js';
import type { Extractor } from './types.js';

/**
 * The extractor registry.
 *
 * Deliberately empty at this stage of the build. Extractors are added here one
 * at a time as they are implemented and tested (SPEC rule 2), so `docgen
 * extract` reports honestly that nothing is registered rather than pretending
 * to have scanned a repo it never parsed.
 */
const REGISTERED: readonly Extractor[] = Object.freeze([]);

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
