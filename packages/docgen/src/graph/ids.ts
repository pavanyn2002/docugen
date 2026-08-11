import type { GraphEdgeKind, GraphNodeKind } from './types.js';

function normaliseKey(key: string): string {
  return key.trim().replace(/\\/g, '/');
}

/** Stable, readable id derived only from an entity's semantic key. */
export function graphNodeId(kind: GraphNodeKind, key: string): string {
  return `${kind}:${normaliseKey(key)}`;
}

/** Stable edge id. The optional discriminator separates repeated relationships. */
export function graphEdgeId(
  kind: GraphEdgeKind,
  from: string,
  to: string,
  discriminator?: string,
): string {
  const suffix = discriminator === undefined ? '' : `#${normaliseKey(discriminator)}`;
  return `edge:${kind}:${from}->${to}${suffix}`;
}
