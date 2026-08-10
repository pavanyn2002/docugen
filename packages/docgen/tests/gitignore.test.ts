import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseGitignore, readGitignore } from '../src/config/gitignore.js';
import { loadConfig } from '../src/config/load.js';
import { schemaExtractor } from '../src/extract/schema/index.js';
import { createLogger } from '../src/util/logger.js';

const silent = createLogger({
  level: 'silent',
  stderr: { write: () => true } as unknown as NodeJS.WritableStream,
  stdout: { write: () => true } as unknown as NodeJS.WritableStream,
});

const created: string[] = [];

async function makeRepo(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-gitignore-'));
  created.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('parseGitignore', () => {
  it('anchors a leading-slash directory to the root only', () => {
    expect(parseGitignore('/output/').patterns).toEqual(['output/**']);
  });

  it('matches a bare directory name at any depth', () => {
    expect(parseGitignore('coverage/').patterns).toEqual(['**/coverage/**']);
  });

  it('treats an interior slash as anchored, per gitignore semantics', () => {
    // `a/b` is a path from the root; `b` alone would be a name at any depth.
    expect(parseGitignore('build/tmp').patterns).toEqual(['build/tmp', 'build/tmp/**']);
  });

  it('covers a bare name as both a file and a directory', () => {
    // Gitignore does not say which it is, so excluding only one would leak.
    expect(parseGitignore('secrets').patterns).toEqual(['**/secrets', '**/secrets/**']);
  });

  it('keeps wildcards and scopes them to any depth', () => {
    expect(parseGitignore('*.log').patterns).toEqual(['**/*.log', '**/*.log/**']);
  });

  it('ignores comments and blank lines', () => {
    expect(parseGitignore('# a comment\n\n   \n/dist/\n').patterns).toEqual(['dist/**']);
  });

  it('reports negations instead of applying half of one', () => {
    // Applying the ignore without the re-inclusion would hide a tracked file.
    const rules = parseGitignore('/build/\n!/build/keep.txt\n');
    expect(rules.patterns).toEqual(['build/**']);
    expect(rules.unsupportedNegations).toEqual(['!/build/keep.txt']);
  });

  it('unescapes a leading marker so \\#file is a real filename', () => {
    expect(parseGitignore('\\#notacomment').patterns).toContain('**/#notacomment');
  });

  it('sorts patterns so config output does not depend on file order', () => {
    const a = parseGitignore('/z/\n/a/\n').patterns;
    const b = parseGitignore('/a/\n/z/\n').patterns;
    expect(a).toEqual(b);
  });

  it('is empty for a repo with no rules', async () => {
    const root = await makeRepo();
    await expect(readGitignore(root)).resolves.toEqual({
      patterns: [],
      unsupportedNegations: [],
    });
  });
});

describe('loadConfig honours .gitignore', () => {
  it('folds gitignore patterns into effectiveExclude by default', async () => {
    const root = await makeRepo({ '.gitignore': '/output/\n' });
    const config = await loadConfig({ root });
    expect(config.effectiveExclude).toContain('output/**');
  });

  it('leaves them out when respectGitignore is false', async () => {
    const root = await makeRepo({
      '.gitignore': '/output/\n',
      'docgen.config.json': JSON.stringify({ respectGitignore: false }),
    });
    const config = await loadConfig({ root });
    expect(config.effectiveExclude).not.toContain('output/**');
  });
});

describe('extraction skips ignored files', () => {
  /**
   * The regression this exists for: a release-staging copy of the migrations
   * under an ignored directory was documented as the schema, and every link in
   * the committed output pointed at a path absent from a fresh clone.
   */
  it('reads the tracked migrations, not an ignored copy of them', async () => {
    const root = await makeRepo({
      '.gitignore': '/output/\n',
      'supabase/migrations/0001_init.sql': 'create table people (id uuid primary key);',
      'output/prod-release/supabase/migrations/0001_init.sql':
        'create table stale_people (id uuid primary key);',
    });

    const config = await loadConfig({ root });
    const result = await schemaExtractor.run({ root, config, logger: silent });

    const files = result.entries.map((entry) => entry.source.file);
    expect(files.every((file) => file.startsWith('supabase/'))).toBe(true);
    expect(result.entries.map((entry) => entry.name)).toContain('people');
    expect(result.entries.map((entry) => entry.name)).not.toContain('stale_people');
  });

  /**
   * The same commit must produce the same bytes regardless of what happens to
   * be built locally, or `docgen check` fails in CI — which clones clean — for
   * a reason invisible in the diff.
   */
  it('produces the same entries whether or not the ignored build output exists', async () => {
    const source = {
      '.gitignore': '/output/\n',
      'supabase/migrations/0001_init.sql': 'create table people (id uuid primary key);',
    };

    const clean = await makeRepo(source);
    const dirty = await makeRepo({
      ...source,
      'output/prod-release/supabase/migrations/0001_init.sql':
        'create table stale_people (id uuid primary key);',
    });

    const run = async (root: string): Promise<readonly string[]> => {
      const config = await loadConfig({ root });
      const result = await schemaExtractor.run({ root, config, logger: silent });
      return result.entries.map((entry) => `${entry.name}:${entry.source.file}`);
    };

    expect(await run(dirty)).toEqual(await run(clean));
  });
});
