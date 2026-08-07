import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_TEST_GLOBS } from '../config/paths.js';
import { KIND_PREFIXES } from '../requirements/types.js';
import { toPosix } from '../util/paths.js';
import { compareStrings } from '../util/sort.js';

/**
 * Find where the test suite cites a requirement.
 *
 * The link between a requirement and the test that covers it has to be
 * something a developer writes once and a parser can read forever. A comment or
 * a test name carrying the id does that, and nothing else does: a naming
 * convention rots, a spreadsheet is abandoned, and a model guessing which test
 * covers which requirement produces exactly the confident-but-wrong mapping
 * this tool exists to prevent.
 *
 *     it('REQ-checkout-01: resubmits after a timeout', ...)
 *     # covers BUG-orders-02
 */

/** Matches an id in any language's comment or string syntax. */
const ID_PATTERN = new RegExp(
  `\\b(${Object.values(KIND_PREFIXES).join('|')})-[a-z0-9][a-z0-9-]*-\\d+\\b`,
  'g',
);

export interface TestReference {
  readonly id: string;
  /** Repo-relative POSIX path of the test file. */
  readonly file: string;
  readonly line: number;
}


export async function scanTestReferences(args: {
  root: string;
  globs?: readonly string[];
  exclude?: readonly string[];
}): Promise<readonly TestReference[]> {
  const files = (
    await fg([...(args.globs ?? DEFAULT_TEST_GLOBS)], {
      cwd: args.root,
      onlyFiles: true,
      ignore: [...(args.exclude ?? [])],
      dot: false,
    })
  )
    .map(toPosix)
    .sort(compareStrings);

  const references: TestReference[] = [];

  for (const relative of files) {
    let contents: string;
    try {
      contents = await fs.readFile(path.join(args.root, relative), 'utf8');
    } catch {
      continue;
    }

    contents.split(/\r?\n/).forEach((line, index) => {
      for (const match of line.matchAll(ID_PATTERN)) {
        references.push({ id: match[0], file: relative, line: index + 1 });
      }
    });
  }

  return references.sort(
    (a, b) => compareStrings(a.id, b.id) || compareStrings(a.file, b.file) || a.line - b.line,
  );
}
