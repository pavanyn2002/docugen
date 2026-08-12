import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCli, main } from '../src/cli.js';
import { parseOnly, runExtractCommand } from '../src/commands/extract.js';
import { EXTRACTOR_IDS } from '../src/types/core.js';
import { createLogger } from '../src/util/logger.js';
import { DocgenError } from '../src/util/errors.js';
import { resolveGraphIndexPath, runIndexGraphCommand } from '../src/commands/index-graph.js';
import { DEFAULT_GRAPH_INDEX, readEvidenceGraph } from '../src/graph/store.js';
import {
  DEFAULT_FILE_FINGERPRINT_INDEX,
  readFileFingerprints,
} from '../src/graph/fingerprints.js';
import {
  DEFAULT_GRAPH_PARTITION_INDEX,
  readGraphPartitions,
} from '../src/graph/partition-store.js';
import { mergeGraphPartitions } from '../src/graph/partitions.js';
import { serialiseEvidenceGraph } from '../src/graph/serialize.js';
import { loadConfig } from '../src/config/load.js';
import { runExtraction } from '../src/pipeline.js';
import {
  parseGraphDirection,
  parseGraphEdgeKinds,
  parseGraphNodeKinds,
  runGraphSearchCommand,
} from '../src/commands/query-graph.js';

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
      'change',
      'check',
      'doctor',
      'explain',
      'extract',
      'feature',
      'fleet',
      'handoff',
      'impact',
      'index',
      'init',
      'legacy',
      'mcp',
      'migrate',
      'path',
      'pilot',
      'plan',
      'policy',
      'query',
      'report',
      'security',
      'session',
      'status',
      'sync',
      'trace',
      'triage',
    ]);
  });

  it('registers the common agent lifecycle', () => {
    const session = buildCli().commands.find((command) => command.name() === 'session');
    expect(session?.commands.map((command) => command.name()).sort()).toEqual([
      'after-edit',
      'end',
      'start',
    ]);
  });

  it('describes every command, so --help is usable', () => {
    for (const command of buildCli().commands) {
      expect(command.description()).not.toBe('');
    }
  });

  it('registers the complete approval-gated legacy workflow', () => {
    const legacy = buildCli().commands.find((command) => command.name() === 'legacy');
    expect(legacy?.commands.map((command) => command.name()).sort()).toEqual([
      'approve',
      'archive',
      'classify',
      'inventory',
      'plan',
    ]);
  });
});

describe('docgen index', () => {
  it('writes a validated symbol graph to the ignored local cache', async () => {
    const root = await makeRepo({
      'package.json': '{"name":"index-fixture"}',
      'src/app.ts': 'function helper() {}\nexport function run() { helper(); }\n',
    });
    const { logger } = captureLogger();

    await runIndexGraphCommand({ cwd: root, logger });

    const file = path.join(root, DEFAULT_GRAPH_INDEX);
    const graph = await readEvidenceGraph(file);
    const fingerprints = await readFileFingerprints(path.join(root, DEFAULT_FILE_FINGERPRINT_INDEX));
    const partitions = await readGraphPartitions(path.join(root, DEFAULT_GRAPH_PARTITION_INDEX));
    expect(graph.nodes.some((node) => node.kind === 'symbol' && node.label === 'run')).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === 'calls')).toBe(true);
    expect(fingerprints?.files.map((entry) => entry.file)).toEqual(['package.json', 'src/app.ts']);
    expect(partitions?.partitions.some((partition) => partition.key === 'src/app.ts')).toBe(true);
    await expect(fs.readFile(path.join(path.dirname(file), '.gitignore'), 'utf8')).resolves.toBe(
      '*\n!.gitignore\n',
    );

    const clean = await runExtraction({
      config: await loadConfig({ root }),
      logger,
      includeSymbols: true,
    });
    expect(serialiseEvidenceGraph(mergeGraphPartitions(partitions!))).toBe(
      serialiseEvidenceGraph(clean.graph),
    );

    const second = captureLogger();
    await runIndexGraphCommand({ cwd: root, logger: second.logger, json: true });
    expect(JSON.parse(second.stdout.join(''))).toMatchObject({
      cacheHit: true,
      extractionSkipped: true,
      symbolAdapters: [
        {
          id: 'python',
          version: '2',
          backend: 'tree-sitter',
        },
        {
          id: 'typescript-javascript',
          version: '4',
          backend: 'typescript-compiler-api',
        },
      ],
      partitions: {
        mode: 'cached',
        equivalent: true,
      },
    });
  });

  it('rebuilds when the symbol extraction profile changes', async () => {
    const root = await makeRepo({
      'src/app.ts': 'export function run() {}\n',
    });
    await runIndexGraphCommand({ cwd: root, logger: captureLogger().logger });

    const second = captureLogger();
    await runIndexGraphCommand({
      cwd: root,
      logger: second.logger,
      symbols: false,
      json: true,
    });

    expect(JSON.parse(second.stdout.join(''))).toMatchObject({
      cacheHit: false,
      extractionSkipped: false,
      includeSymbols: false,
      partitions: { mode: 'full' },
    });
  });

  it('indexes Python symbols through the built-in Tree-sitter adapter', async () => {
    const root = await makeRepo({
      'pyproject.toml': '[project]\nname = "python-index-fixture"\nversion = "1.0.0"\n',
      'app.py': 'def helper():\n    pass\n\ndef run():\n    helper()\n',
    });
    await runIndexGraphCommand({ cwd: root, logger: captureLogger().logger });

    const graph = await readEvidenceGraph(path.join(root, DEFAULT_GRAPH_INDEX));
    expect(graph.nodes.find((node) => node.label === 'run')).toMatchObject({
      kind: 'symbol',
      properties: { language: 'python', parserBackend: 'tree-sitter' },
    });
    expect(graph.edges.find((edge) => edge.kind === 'calls')).toMatchObject({
      from: 'symbol:app.py#function:run',
      to: 'symbol:app.py#function:helper',
    });
  });

  it('indexes proven cross-file database access against the extracted schema', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"@prisma/client":"1.0.0"}}',
      'prisma/schema.prisma': [
        'model User {',
        '  id Int @id',
        '}',
      ].join('\n'),
      'src/db.ts': [
        "import { PrismaClient } from '@prisma/client';",
        'export const db = new PrismaClient();',
      ].join('\n'),
      'src/users.ts': [
        "import { db } from './db';",
        'export function listUsers() { return db.user.findMany(); }',
      ].join('\n'),
    });
    await runIndexGraphCommand({ cwd: root, logger: captureLogger().logger });

    const graph = await readEvidenceGraph(path.join(root, DEFAULT_GRAPH_INDEX));
    const access = graph.edges.find(
      (edge) => edge.kind === 'references' && edge.properties?.referenceKind === 'database-access',
    );
    expect(access).toMatchObject({
      from: 'symbol:src/users.ts#function:listUsers',
      properties: { orm: 'prisma', operation: 'findMany', model: 'user' },
    });
    expect(graph.nodes.find((node) => node.id === access?.to)).toMatchObject({
      kind: 'schema',
      label: 'User',
    });
  });

  it('indexes a cross-file queue producer against its extracted consumer job', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"bullmq":"1.0.0"}}',
      'src/queue.ts': [
        "import { Queue } from 'bullmq';",
        "export const emailQueue = new Queue('emails');",
      ].join('\n'),
      'src/producer.ts': [
        "import { emailQueue } from './queue';",
        "export function notify() { return emailQueue.add('welcome', {}); }",
      ].join('\n'),
      'src/worker.ts': [
        "import { Worker } from 'bullmq';",
        "new Worker('emails', async () => undefined);",
      ].join('\n'),
    });
    await runIndexGraphCommand({ cwd: root, logger: captureLogger().logger });

    const graph = await readEvidenceGraph(path.join(root, DEFAULT_GRAPH_INDEX));
    const producer = graph.edges.find(
      (edge) => edge.kind === 'references' && edge.properties?.referenceKind === 'queue-producer',
    );
    expect(producer).toMatchObject({
      from: 'symbol:src/producer.ts#function:notify',
      properties: { runtime: 'bullmq', channel: 'emails', jobName: 'welcome' },
    });
    expect(graph.nodes.find((node) => node.id === producer?.to)).toMatchObject({
      kind: 'job',
      label: 'emails',
      properties: { jobKind: 'queue-consumer', channel: 'emails' },
    });
  });

  it('rebuilds when the resolved configuration changes without file changes', async () => {
    const root = await makeRepo({
      'config-a.json': '{"extractors":{"routes":true}}',
      'config-b.json': '{"extractors":{"routes":false}}',
      'src/app.ts': 'export function run() {}\n',
    });
    await runIndexGraphCommand({
      cwd: root,
      configFile: 'config-a.json',
      logger: captureLogger().logger,
    });

    const second = captureLogger();
    await runIndexGraphCommand({
      cwd: root,
      configFile: 'config-b.json',
      logger: second.logger,
      json: true,
    });

    expect(JSON.parse(second.stdout.join(''))).toMatchObject({
      cacheHit: false,
      extractionSkipped: false,
      changes: { added: 0, changed: 0, deleted: 0 },
      partitions: { mode: 'full' },
    });
  });

  it('rebuilds only the reverse-dependency closure and remains clean-build equivalent', async () => {
    const root = await makeRepo({
      'package.json': '{"name":"scoped-index"}',
      'src/a.ts': "import { target } from './b';\nexport function caller() { target(); }\n",
      'src/b.ts': 'export function target() { return 1; }\n',
      'src/c.ts': 'export function independent() { return 1; }\n',
    });
    await runIndexGraphCommand({ cwd: root, logger: captureLogger().logger });
    await fs.writeFile(
      path.join(root, 'src', 'b.ts'),
      'function helper() { return 2; }\nexport function target() { return helper(); }\n',
      'utf8',
    );

    const second = captureLogger();
    await runIndexGraphCommand({ cwd: root, logger: second.logger, json: true });
    expect(JSON.parse(second.stdout.join(''))).toMatchObject({
      cacheHit: false,
      extractionSkipped: false,
      extractionScope: { mode: 'scoped', files: 2 },
      partitions: { mode: 'incremental', reused: 1, verification: 'partition-integrity' },
    });

    const indexed = await readEvidenceGraph(path.join(root, DEFAULT_GRAPH_INDEX));
    const clean = await runExtraction({
      config: await loadConfig({ root }),
      logger: captureLogger().logger,
      includeSymbols: true,
    });
    expect(serialiseEvidenceGraph(indexed)).toBe(serialiseEvidenceGraph(clean.graph));

    const third = captureLogger();
    await runIndexGraphCommand({ cwd: root, logger: third.logger, json: true });
    expect(JSON.parse(third.stdout.join(''))).toMatchObject({
      cacheHit: true,
      extractionSkipped: true,
      partitions: { mode: 'cached', verification: 'cache-integrity' },
    });
  });

  it('supports a dry run and rejects indexes outside the repository', async () => {
    const root = await makeRepo({ 'src/app.ts': 'export function run() {}\n' });
    const { logger } = captureLogger();

    await runIndexGraphCommand({ cwd: root, logger, dryRun: true });

    await expect(fs.stat(path.join(root, DEFAULT_GRAPH_INDEX))).rejects.toThrow();
    expect(() => resolveGraphIndexPath(root, '../outside.json')).toThrow(/inside the target repository/);
  });
});

describe('live graph commands', () => {
  it('validates graph filters and directions', () => {
    expect(parseGraphNodeKinds('route, symbol')).toEqual(['route', 'symbol']);
    expect(parseGraphEdgeKinds('calls,extends')).toEqual(['calls', 'extends']);
    expect(parseGraphDirection(undefined)).toBe('outgoing');
    expect(parseGraphDirection('both')).toBe('both');
    expect(() => parseGraphNodeKinds('widget')).toThrow(/widget/);
    expect(() => parseGraphDirection('sideways')).toThrow(/sideways/);
  });

  it('searches a graph rebuilt from the current working tree', async () => {
    const root = await makeRepo({
      'src/checkout.ts': 'export function checkout() {}\n',
    });
    const { logger, stdout } = captureLogger();

    await runGraphSearchCommand({ cwd: root, text: 'checkout', kinds: 'symbol', json: true, logger });

    expect(JSON.parse(stdout.join(''))).toMatchObject({
      query: 'checkout',
      count: 1,
      nodes: [{ kind: 'symbol', label: 'checkout' }],
    });
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
  }, 20_000);

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
