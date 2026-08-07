import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Engine version, stamped into the front matter of every generated file so a
 * reader can tell which parser produced a claim.
 *
 * Read from package.json at runtime rather than hardcoded, so a release bump
 * cannot silently disagree with what the docs say produced them.
 */
function readVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/util/ during tests, dist/util/ once built — package.json is two up from both.
  const candidates = [
    path.resolve(here, '..', '..', 'package.json'),
    path.resolve(here, '..', '..', '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'name' in parsed &&
        parsed.name === '@tatvaops/docgen' &&
        'version' in parsed &&
        typeof parsed.version === 'string'
      ) {
        return parsed.version;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return '0.0.0-unknown';
}

export const ENGINE_VERSION: string = readVersion();
