import type { EvidenceGraph } from '../graph/types.js';
import type { FeatureCard } from './types.js';

/** A committed card cannot keep a deleted QA surface alive. */
export function activeCards(cards: readonly FeatureCard[], graph: EvidenceGraph): readonly FeatureCard[] {
  const liveIds = new Set(graph.nodes.filter((node) => node.kind === 'surface').map((node) => node.properties?.['surfaceId']));
  return cards.filter((card) => liveIds.has(card.surfaceId));
}
