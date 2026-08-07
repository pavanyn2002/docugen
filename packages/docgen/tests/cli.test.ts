import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCli, main } from '../src/cli.js';
import { parseOnly, runExtractCommand } from '../src/commands/extract.js';
import { EXTRACTOR_IDS } from '../src/types/core.js';
import { createLogger } from '../src/util/logger.js';
import { DocgenError } from '../src/util/errors.js';

const created: string[] = [];

async function makeRepo(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-cli-'));
  created.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }
  return dir;
}

/** Collects logger output so assertions do not depend on process streams. */
function captureLogger() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sink = (bucket: string[]): NodeJS.WritableStream =>
    ({ write: (chunk: string) => (bucket.push(chunk), true) }) as unknown as NodeJS.WritableStream;
  return {
    stdout,
    stderr,
    logger: createLogger({ level: 'info', stdout: sink(stdout), stderr: sink(stderr) }),
  };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('CLI shape', () => {
  it('exposes the global options adapters will depend on', () => {
    const flags = buildCli()
      .options.map((option) => option.long)
      .filter((long): long is string => long !== undefined);

    expect(flags).toEqual(expect.arrayContaining(['--cwd', '--config', '--verbose', '--quiet', '--version']));
  });
});

describe('command surface', () => {
  // Every command named in the SPEC, and the exact set that adapters, CI jobs,
  // and the instructions docgen writes into AGENTS.md depend on. Losing or
  // renaming one silently breaks every repo the plugin is installed into.
  it('registers every documented command', () => {
    const names = buildCli()
      .commands.map((command) => command.name())
      .sort();

    expect(names).toEqual([
      'answer',
      'ask',
      'bootstrap',
      'check',
      'extract',
      'init',
      'report',
      'sync',
      'trace',
      'triage',
    ]);
  });

  it('describes every command, so --help is usable', () => {
    for (const command of buildCli().commands) {
      expect(command.description()).not.toBe('');
    }
  });
});

describe('--only parsing', () => {
  it('accepts a comma-separated list of known extractors', () => {
    expect(parseOnly('routes,schema')).toEqual(['routes', 'schema']);
  });

  it('tolerates whitespace and empty segments', () => {
    expect(parseOnly(' routes , , jobs ')).toEqual(['routes', 'jobs']);
  });

  it('rejects an unknown extractor, naming it', () => {
    expect(() => parseOnly('routes,widgets')).toThrow(/widgets/);
  });

  it('lists the valid extractors in the remedy so the user can self-correct', () => {
    try {
      parseOnly('widgets');
      expect.unreachable('parseOnly should have thrown');
    } catch (error) {
      expect((error as DocgenError).remedy).toMatch(new RegExp(EXTRACTOR_IDS.join('.*')));
    }
  });

  it('returns undefined when the flag is absent', () => {
    expect(parseOnly(undefined)).toBeUndefined();
  });
});

describe('process exit codes', () => {
  const argv = (...args: string[]): string[] => ['node', 'docgen', ...args];

  it('returns 0 on a successful run', async () => {
    const root = await makeRepo();
    await expect(main(argv('extract', '--cwd', root, '--quiet'))).resolves.toBe(0);
  });

  // CI wired to `docgen check` must fail rather than pass on an unbuilt gate.
  it('returns 1 for a not-implemented command', async () => {
    await expect(main(argv('check', '--quiet'))).resolves.toBe(1);
  });

  it('returns 1 for a malformed config', async () => {
    const root = await makeRepo({ 'docgen.config.json': '{ broken' });
    await expect(main(argv('extract', '--cwd', root, '--quiet'))).resolves.toBe(1);
  });

  it('returns 1 for an unknown extractor', async () => {
    const root = await makeRepo();
    await expect(main(argv('extract', '--cwd', root, '--only', 'widgets', '--quiet'))).resolves.toBe(1);
  });
});

describe('docgen extract', () => {
  it('runs on a repo with no config and no recognised technology', async () => {
    const root = await makeRepo({ 'package.json': '{"name":"empty"}' });
    const { logger, stderr } = captureLogger();

    const result = await runExtractCommand({ cwd: root, json: false, logger });

    // routes is registered and correctly reports the technology as absent.
    expect(result.results.get('routes')).toMatchObject({ applicable: false, entries: [] });
    expect(stderr.join('')).toContain('docgen extract');
  });

  // Every SPEC extractor is now implemented, so nothing should be reported as
  // missing. The mechanism stays tested so a future addition cannot go silent.
  it('reports no unimplemented extractors now that all six exist', async () => {
    const root = await makeRepo();
    const { logger } = captureLogger();

    const result = await runExtractCommand({ cwd: root, json: false, logger });

    expect([...result.results.keys()].sort()).toEqual([...EXTRACTOR_IDS].sort());
    expect(result.unimplemented).toEqual([]);
  });

  it('honours extractor toggles from config', async () => {
    const root = await makeRepo({
      'docgen.config.json': JSON.stringify({ extractors: { jobs: false, deps: false } }),
    });
    const { logger } = captureLogger();

    const result = await runExtractCommand({ cwd: root, json: false, logger });

    expect([...result.disabled].sort()).toEqual(['deps', 'jobs']);
    expect(result.unimplemented).not.toContain('jobs');
  });

  it('restricts the run to --only', async () => {
    const root = await makeRepo();
    const { logger } = captureLogger();

    const result = await runExtractCommand({ cwd: root, only: 'jobs', json: false, logger });

    // Only the named extractor runs; the others are not consulted at all.
    expect([...result.results.keys()]).toEqual(['jobs']);
    expect(result.results.has('routes')).toBe(false);
  });

  it('lets --out override the configured output directory', async () => {
    const root = await makeRepo({ 'docgen.config.json': JSON.stringify({ outDir: 'docs/generated' }) });
    const { logger } = captureLogger();

    const result = await runExtractCommand({ cwd: root, outDir: 'custom/docs', json: false, logger });

    expect(result.config.outDir).toBe('custom/docs');
  });

  it('emits parseable JSON on stdout with --json, keeping diagnostics on stderr', async () => {
    const root = await makeRepo();
    const { logger, stdout, stderr } = captureLogger();

    await runExtractCommand({ cwd: root, json: true, logger });

    const parsed: unknown = JSON.parse(stdout.join(''));
    expect(parsed).toMatchObject({ outDir: 'docs/generated' });
    expect(stderr.join('')).not.toContain('{');
  });

  // Durations vary run to run; letting one reach output would break the
  // byte-determinism requirement the moment it is rendered.
  it('excludes timing from JSON output', async () => {
    const root = await makeRepo();
    const { logger, stdout } = captureLogger();

    await runExtractCommand({ cwd: root, json: true, logger });

    expect(stdout.join('')).not.toMatch(/durationMs/i);
  });

  // --dry-run must leave the repo untouched, so it is safe to run anywhere.
  it('performs no writes with --dry-run', async () => {
    const root = await makeRepo({ 'package.json': '{"name":"x"}' });
    const before = (await fs.readdir(root)).sort();
    const { logger } = captureLogger();

    await runExtractCommand({ cwd: root, dryRun: true, json: false, logger });

    expect((await fs.readdir(root)).sort()).toEqual(before);
  });

  it('writes the documentation set by default', async () => {
    const root = await makeRepo({ 'package.json': '{"name":"x"}' });
    const { logger } = captureLogger();

    await runExtractCommand({ cwd: root, json: false, logger });

    await expect(fs.readFile(path.join(root, 'docs/generated/README.md'), 'utf8')).resolves.toContain(
      'Generated documentation',
    );
  });
});
