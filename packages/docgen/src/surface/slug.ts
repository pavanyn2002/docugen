import { createHash } from 'node:crypto';

/**
 * Filesystem-safe slugs for surface ids.
 *
 * Phase 1 files developer answers under the surface slug, so a slug that
 * silently collides would merge two features' ground truth. Collisions are
 * therefore detected and disambiguated rather than left to chance.
 */

/** Lowercase, ASCII-safe, no leading/trailing or repeated separators. */
export function sanitiseSlug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'index';
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * Assign a unique slug to each id.
 *
 * When two ids sanitise to the same slug (`/orders/[id]` and `/orders/id` both
 * become `orders-id`), every member of that colliding group gets a hash suffix.
 * Suffixing all of them rather than all-but-one keeps the result independent of
 * iteration order, so the same input always produces the same slugs.
 *
 * Note this means removing one of a colliding pair reverts the survivor to the
 * plain slug. That is a deliberate trade: determinism for a given input beats
 * stability across inputs, because byte-identical output is a hard requirement
 * and colliding ids are rare.
 */
export function assignSlugs(ids: readonly string[]): ReadonlyMap<string, string> {
  const byBase = new Map<string, string[]>();
  for (const id of ids) {
    const base = sanitiseSlug(id);
    const bucket = byBase.get(base);
    if (bucket === undefined) byBase.set(base, [id]);
    else bucket.push(id);
  }

  const result = new Map<string, string>();
  for (const [base, members] of byBase) {
    if (members.length === 1) {
      result.set(members[0] as string, base);
      continue;
    }
    for (const id of members) {
      result.set(id, `${base}-${shortHash(id)}`);
    }
  }
  return result;
}
