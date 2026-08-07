import { createColors } from 'picocolors';
import type { Colors } from 'picocolors/types.js';

/**
 * Decide whether to emit ANSI colour.
 *
 * picocolors' own detection enables colour on Windows even when the stream is a
 * pipe, which leaks escape codes into CI logs and redirected files. Detection
 * is done explicitly here instead, honouring the NO_COLOR and FORCE_COLOR
 * conventions.
 */
export function resolveColorEnabled(options: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stream: { isTTY?: boolean };
}): boolean {
  if (options.argv.includes('--no-color')) return false;
  if (options.env['NO_COLOR'] !== undefined && options.env['NO_COLOR'] !== '') return false;
  if (options.argv.includes('--color')) return true;
  if (options.env['FORCE_COLOR'] !== undefined && options.env['FORCE_COLOR'] !== '0') return true;
  if (options.env['TERM'] === 'dumb') return false;
  return options.stream.isTTY === true;
}

let active: Colors = createColors(false);

/** Must be called before any coloured string is built. */
export function configureColors(enabled: boolean): void {
  active = createColors(enabled);
}

/** Current colour palette. Read at call time so configureColors() takes effect. */
export function colors(): Colors {
  return active;
}
