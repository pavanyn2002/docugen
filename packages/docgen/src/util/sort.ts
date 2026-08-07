/**
 * Locale-independent string ordering.
 *
 * `String.prototype.localeCompare` sorts by the host's default locale, so the
 * same repository can order identically-named entries differently on two
 * developers' machines — and byte-identical output across runs is the one
 * property this tool cannot compromise on. Comparing code units directly is
 * stable everywhere.
 */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
