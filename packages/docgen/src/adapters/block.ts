/**
 * Managed blocks inside files docgen does not own.
 *
 * `AGENTS.md`, `CLAUDE.md` and Cursor rule files belong to the team. docgen
 * needs a few lines in them and must never take more than that: everything
 * between the markers is replaced, everything outside is preserved byte for
 * byte, and a file that already has a block is edited rather than rewritten.
 *
 * The failure this prevents is specific and bad — a developer's carefully
 * written agent instructions silently replaced by a tool they installed once.
 */

export const BLOCK_START = '<!-- docgen:start -->';
export const BLOCK_END = '<!-- docgen:end -->';

/** A hand edit inside the block is lost on the next run, so say so. */
const BLOCK_NOTICE =
  '<!-- Managed by docgen. Edits between these markers are overwritten; edit outside them freely. -->';

export interface UpsertResult {
  readonly contents: string;
  /** 'created' | 'updated' | 'unchanged' — for an honest report to the user. */
  readonly action: 'created' | 'updated' | 'unchanged';
}

/**
 * Insert or replace docgen's block in `existing`.
 *
 * A missing block is appended rather than prepended: the team's own
 * instructions are what they wrote first and should stay at the top.
 */
export function upsertManagedBlock(existing: string, body: string): UpsertResult {
  const block = [BLOCK_START, BLOCK_NOTICE, '', body.trimEnd(), '', BLOCK_END].join('\n');

  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);

  if (start === -1 || end === -1 || end < start) {
    // No block, or one so mangled that replacing "between the markers" would
    // eat unrelated content. Appending is the only safe move.
    const prefix = existing.trimEnd();
    const contents = prefix.length === 0 ? `${block}\n` : `${prefix}\n\n${block}\n`;
    return { contents, action: 'created' };
  }

  const before = existing.slice(0, start);
  const after = existing.slice(end + BLOCK_END.length);
  const contents = `${before}${block}${after}`;

  return { contents, action: contents === existing ? 'unchanged' : 'updated' };
}
