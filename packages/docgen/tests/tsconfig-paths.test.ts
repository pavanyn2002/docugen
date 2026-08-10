import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { aliasCandidates, loadPathAliases } from '../src/util/tsconfig.js';
import { resolveImport, resolveRelativeImport } from '../src/util/modules.js';
import { loadConfig } from '../src/config/load.js';
import { depsExtractor } from '../src/extract/deps/index.js';
import { createLogger } from '../src/util/logger.js';

const silent = createLogger({
  level: 'silent',
  stderr: { write: () => true } as unknown as NodeJS.WritableStream,
  stdout: { write: () => true } as unknown as NodeJS.WritableStream,
});

const created: string[] = [];

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-paths-'));
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

describe('loadPathAliases', () => {
  it('reads the Next.js default of @/* mapped to the repo root', async () => {
    const root = await makeRepo({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
    });
    const aliases = await loadPathAliases(root);
    expect(aliasCandidates('@/lib/db', aliases)).toEqual(['lib/db']);
  });

  it('parses a tsconfig containing comments and trailing commas', async () => {
    // tsconfig is JSONC. JSON.parse would throw on a perfectly valid file.
    const root = await makeRepo({
      'tsconfig.json': `{
        // the alias every scaffold ships with
        "compilerOptions": {
          "paths": { "@/*": ["./src/*"], },
        },
      }`,
    });
    const aliases = await loadPathAliases(root);
    expect(aliasCandidates('@/lib/db', aliases)).toEqual(['src/lib/db']);
  });

  it('resolves targets against baseUrl when one is set', async () => {
    const root = await makeRepo({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: './src', paths: { '~/*': ['./modules/*'] } },
      }),
    });
    const aliases = await loadPathAliases(root);
    expect(aliasCandidates('~/auth', aliases)).toEqual(['src/modules/auth']);
  });

  it('follows extends to find paths declared in a base config', async () => {
    const root = await makeRepo({
      'tsconfig.base.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./app/*'] } } }),
      'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }),
    });
    const aliases = await loadPathAliases(root);
    expect(aliasCandidates('@/page', aliases)).toEqual(['app/page']);
  });

  it('prefers the more specific pattern, as TypeScript does', async () => {
    const root = await makeRepo({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@/*': ['./src/*'], '@/ui/*': ['./packages/ui/*'] } },
      }),
    });
    const aliases = await loadPathAliases(root);
    expect(aliasCandidates('@/ui/button', aliases)[0]).toBe('packages/ui/button');
  });

  it('offers every target of a multi-target alias, in order', async () => {
    const root = await makeRepo({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@/*': ['./src/*', './vendor/*'] } },
      }),
    });
    const aliases = await loadPathAliases(root);
    expect(aliasCandidates('@/thing', aliases)).toEqual(['src/thing', 'vendor/thing']);
  });

  it('drops a target that escapes the repo, since it can never be scanned', async () => {
    const root = await makeRepo({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['../outside/*'] } } }),
    });
    expect(await loadPathAliases(root)).toEqual([]);
  });

  it('returns nothing for a repo with no tsconfig, rather than throwing', async () => {
    const root = await makeRepo({ 'index.js': '' });
    await expect(loadPathAliases(root)).resolves.toEqual([]);
  });

  it('returns nothing for an unparseable tsconfig, rather than throwing', async () => {
    const root = await makeRepo({ 'tsconfig.json': '{ this is not json at all' });
    await expect(loadPathAliases(root)).resolves.toEqual([]);
  });
});

describe('resolveImport', () => {
  const files = new Set(['components/app-sidebar.tsx', 'lib/db.ts', 'lib/index.ts']);

  it('still resolves a relative import', () => {
    expect(resolveImport('lib/index.ts', './db', files)).toBe('lib/db.ts');
  });

  it('resolves an aliased import that the relative resolver cannot', async () => {
    const root = await makeRepo({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
    });
    const aliases = await loadPathAliases(root);

    // The regression: this is how a Next.js app imports nearly everything.
    expect(resolveRelativeImport('app/layout.tsx', '@/components/app-sidebar', files)).toBeUndefined();
    expect(resolveImport('app/layout.tsx', '@/components/app-sidebar', files, aliases)).toBe(
      'components/app-sidebar.tsx',
    );
  });

  it('leaves a real package unresolved', async () => {
    const root = await makeRepo({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
    });
    const aliases = await loadPathAliases(root);
    expect(resolveImport('lib/db.ts', 'react', files, aliases)).toBeUndefined();
  });
});

describe('deps extractor with aliases', () => {
  /**
   * Two failures came from the same root cause: an aliased specifier looks
   * external, so `@/components/app-sidebar` was counted as a package named
   * `@/components` — inventing a dependency that does not exist — while the
   * real edge vanished, leaving the imported module looking like an orphan.
   */
  it('records an aliased import as an internal edge, not an external package', async () => {
    const root = await makeRepo({
      'package.json': JSON.stringify({ name: 'app', dependencies: { react: '^18.0.0' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
      'components/app-sidebar.tsx': 'export const AppSidebar = () => null;',
      'app/layout.tsx':
        "import { AppSidebar } from '@/components/app-sidebar';\nimport React from 'react';\nexport default AppSidebar;",
    });

    const config = await loadConfig({ root });
    const result = await depsExtractor.run({ root, config, logger: silent });

    const layout = result.entries.find((entry) => entry.source.file === 'app/layout.tsx');
    expect(layout?.imports).toContain('components/app-sidebar.tsx');
    expect(layout?.externals).toContain('react');
    expect(layout?.externals).not.toContain('@/components');
  });
});
