import path from 'node:path';

/**
 * Convert an absolute or platform-native path to a repo-relative POSIX path.
 *
 * Every path that reaches generated output goes through here. Without it, the
 * same repo produces different bytes on Windows and Linux, which would break
 * the byte-determinism requirement (SPEC 6.2) for any team that isn't all on
 * one OS.
 */
export function toRepoRelativePosix(root: string, target: string): string {
  const relative = path.relative(root, path.resolve(root, target));
  return relative.split(path.sep).join('/');
}

/** Normalise an already-relative path to POSIX separators. */
export function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/** True when `target` is inside `root` — guards against `../` escapes in config globs. */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, path.resolve(root, target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
