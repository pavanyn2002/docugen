import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '../src/config/define.js';
import { inapplicable, skip } from '../src/extract/types.js';
import { DocgenError, describeUnknownError, isDocgenError } from '../src/util/errors.js';
import { resolveSourceCommit } from '../src/util/git.js';
import { createLogger } from '../src/util/logger.js';
import { isInside, toPosix, toRepoRelativePosix } from '../src/util/paths.js';
import { ENGINE_VERSION } from '../src/util/version.js';

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-util-'));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('path normalisation', () => {
  // Without POSIX normalisation the same repo emits different bytes on Windows
  // and Linux, breaking determinism for any team not all on one OS.
  it('produces POSIX separators from a native absolute path', () => {
    const root = path.resolve('/repo');
    const file = path.join(root, 'src', 'app', 'page.tsx');
    expect(toRepoRelativePosix(root, file)).toBe('src/app/page.tsx');
  });

  it('is idempotent for an already-relative POSIX path', () => {
    const root = path.resolve('/repo');
    expect(toRepoRelativePosix(root, 'src/index.ts')).toBe('src/index.ts');
  });

  it('returns an empty string for the root itself', () => {
    const root = path.resolve('/repo');
    expect(toRepoRelativePosix(root, root)).toBe('');
  });

  it('converts native separators without touching forward slashes', () => {
    expect(toPosix(['a', 'b', 'c'].join(path.sep))).toBe('a/b/c');
    expect(toPosix('a/b/c')).toBe('a/b/c');
  });

  it('detects containment', () => {
    const root = path.resolve('/repo');
    expect(isInside(root, path.join(root, 'src'))).toBe(true);
    expect(isInside(root, root)).toBe(true);
  });

  it('rejects a parent-directory escape', () => {
    const root = path.resolve('/repo');
    expect(isInside(root, path.join(root, '..', 'other'))).toBe(false);
    expect(isInside(root, '../secrets')).toBe(false);
  });
});

describe('errors', () => {
  it('carries a code, a remedy, and an optional file', () => {
    const error = new DocgenError({
      code: 'config-invalid',
      message: 'bad',
      remedy: 'fix it',
      file: '/repo/docgen.config.ts',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DocgenError');
    expect(error.code).toBe('config-invalid');
    expect(error.remedy).toBe('fix it');
    expect(error.file).toBe('/repo/docgen.config.ts');
  });

  it('omits file when not supplied', () => {
    expect(new DocgenError({ code: 'x', message: 'm', remedy: 'r' }).file).toBeUndefined();
  });

  it('preserves the underlying cause', () => {
    const cause = new Error('root cause');
    expect(new DocgenError({ code: 'x', message: 'm', remedy: 'r', cause }).cause).toBe(cause);
  });

  it('narrows with isDocgenError', () => {
    expect(isDocgenError(new DocgenError({ code: 'x', message: 'm', remedy: 'r' }))).toBe(true);
    expect(isDocgenError(new Error('plain'))).toBe(false);
    expect(isDocgenError('string')).toBe(false);
  });

  it.each([
    [new Error('boom'), 'boom'],
    ['already a string', 'already a string'],
    [{ nested: true }, '{"nested":true}'],
  ])('describes %o', (input, expected) => {
    expect(describeUnknownError(input)).toBe(expected);
  });

  it('falls back to String() for an unserialisable value', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(describeUnknownError(circular)).toBe('[object Object]');
  });
});

describe('git provenance', () => {
  // SPEC rule 6: a non-git directory is absent input, not malformed input.
  it('returns undefined outside a git checkout rather than throwing', async () => {
    await expect(resolveSourceCommit(await tempDir())).resolves.toBeUndefined();
  });

  it('resolves the HEAD sha in a real checkout', async () => {
    const dir = await tempDir();
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
    };

    try {
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('commit', '--allow-empty', '-q', '-m', 'init');
    } catch {
      // git unavailable in this environment; the absent-input case above still holds.
      return;
    }

    await expect(resolveSourceCommit(dir)).resolves.toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('logger levels', () => {
  function capture(level: Parameters<typeof createLogger>[0] extends undefined ? never : 'silent' | 'error' | 'warn' | 'info' | 'debug') {
    const out: string[] = [];
    const err: string[] = [];
    const sink = (bucket: string[]): NodeJS.WritableStream =>
      ({ write: (chunk: string) => (bucket.push(chunk), true) }) as unknown as NodeJS.WritableStream;
    const logger = createLogger({ level, stdout: sink(out), stderr: sink(err) });
    return { logger, out, err };
  }

  it('emits everything at debug', () => {
    const { logger, err } = capture('debug');
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    logger.heading('h');
    expect(err).toHaveLength(5);
  });

  it('suppresses info and debug at warn', () => {
    const { logger, err } = capture('warn');
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    expect(err.join('')).toContain('e');
    expect(err.join('')).not.toContain('i');
  });

  it('emits nothing at silent', () => {
    const { logger, err } = capture('silent');
    logger.error('e');
    logger.warn('w');
    expect(err).toEqual([]);
  });

  // stdout must stay parseable even when diagnostics are suppressed.
  it('writes output() to stdout regardless of level', () => {
    const { logger, out, err } = capture('silent');
    logger.output('{"ok":true}');
    expect(out.join('')).toContain('{"ok":true}');
    expect(err).toEqual([]);
  });
});

describe('extractor helpers', () => {
  it('builds an inapplicable result that is empty but not an error', () => {
    const result = inapplicable('schema', [skip('schema', 'no-prisma-schema', 'No prisma/schema.prisma found.')]);

    expect(result.applicable).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.gaps).toEqual([]);
    expect(result.skips[0]).toMatchObject({ extractor: 'schema', kind: 'no-prisma-schema' });
  });
});

describe('misc', () => {
  it('defineConfig returns its input unchanged', () => {
    const config = { outDir: 'docs/generated' };
    expect(defineConfig(config)).toBe(config);
  });

  it('resolves the real engine version, not the unknown fallback', () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(ENGINE_VERSION).not.toBe('0.0.0-unknown');
  });
});
