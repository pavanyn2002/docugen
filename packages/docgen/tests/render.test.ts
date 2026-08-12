import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config/load.js';
import { runExtraction } from '../src/pipeline.js';
import type { RunResult } from '../src/pipeline.js';
import { ensureGitattributes, renderAll, writeAll } from '../src/render/index.js';
import { GENERATED_MARKER, pathToRepoRoot, renderFrontMatter, sourceLink, table } from '../src/render/markdown.js';
import { renderErd, renderIntegrations, renderModules, renderSitemap } from '../src/render/diagrams.js';
import { createLogger } from '../src/util/logger.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const FIXTURES = path.join(TEST_DIR, 'fixtures');

const silent = createLogger({
  level: 'silent',
  stderr: { write: () => true } as unknown as NodeJS.WritableStream,
  stdout: { write: () => true } as unknown as NodeJS.WritableStream,
});

async function runOn(root: string): Promise<RunResult> {
  const config = await loadConfig({ root });
  return runExtraction({ config, logger: silent });
}

function fileNamed(files: readonly { path: string; contents: string }[], name: string): string {
  return files.find((file) => file.path.endsWith(name))?.contents ?? '';
}

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** Copy a fixture so writes never touch the committed fixtures. */
/**
 * Copy a fixture to a scratch directory, excluding anything docgen itself
 * writes. Running docgen against a fixture in place — which CI and any curious
 * developer will do — otherwise leaves output behind that these tests then
 * treat as part of the fixture, and they start failing for reasons that have
 * nothing to do with the code.
 */
async function copyFixture(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-render-'));
  created.push(dir);
  await fs.cp(path.join(FIXTURES, name), dir, {
    recursive: true,
    filter: (source) => {
      // Only docgen's own output. `docs/` also holds real fixture inputs —
      // express-service keeps its OpenAPI spec at docs/openapi.yaml, which the
      // spec cross-check tests need.
      const relative = path.relative(path.join(FIXTURES, name), source).split(path.sep).join('/');
      return !relative.startsWith('docs/generated') && relative !== '.gitattributes';
    },
  });
  return dir;
}

// ── file set ─────────────────────────────────────────────────────────────────

describe('rendered file set', () => {
  it('produces the pages and diagrams the SPEC names', async () => {
    const files = renderAll(await runOn(path.join(FIXTURES, 'express-service')));

    expect(files.map((file) => file.path)).toEqual([
      'docs/generated/README.md',
      'docs/generated/api.md',
      'docs/generated/config.md',
      'docs/generated/diagrams/erd.mmd',
      'docs/generated/diagrams/integrations.mmd',
      'docs/generated/diagrams/modules.mmd',
      'docs/generated/diagrams/sitemap.mmd',
      'docs/generated/jobs.md',
      'docs/generated/routes.md',
      'docs/generated/schema.md',
    ]);
  });

  it('honours a configured output directory', async () => {
    const config = await loadConfig({ root: path.join(FIXTURES, 'express-service') });
    const run = await runExtraction({
      config: { ...config, outDir: 'documentation' },
      logger: silent,
    });

    expect(renderAll(run).every((file) => file.path.startsWith('documentation/'))).toBe(true);
  });
});

// ── front matter and provenance ──────────────────────────────────────────────

describe('front matter', () => {
  it('stamps provenance on every page', async () => {
    const files = renderAll(await runOn(path.join(FIXTURES, 'express-service')));

    for (const file of files.filter((candidate) => candidate.path.endsWith('.md'))) {
      expect(file.contents).toMatch(/^---\ngenerated: true\n/);
      expect(file.contents).toContain('confidence: verified');
      expect(file.contents).toContain('engine_version:');
      expect(file.contents).toContain(GENERATED_MARKER);
    }
  });

  it('never stamps a run time or self-referential commit into any page', async () => {
    const files = renderAll(await runOn(path.join(FIXTURES, 'express-service')));
    for (const file of files) {
      expect(file.contents).not.toContain('generated_at:');
      expect(file.contents).not.toContain('source_commit:');
    }
  });

  it('stamps the canonical evidence fingerprint instead of the enclosing commit', () => {
    const withFingerprint = renderFrontMatter({
      title: 'x',
      confidence: 'verified',
      context: {
        engineVersion: '1.0.0',
        evidenceFingerprint: 'a'.repeat(64),
      },
    });
    expect(withFingerprint).toContain(`evidence_fingerprint: sha256:${'a'.repeat(64)}`);
  });

  it('states when no evidence fingerprint was supplied', () => {
    const withoutFingerprint = renderFrontMatter({
      title: 'x',
      confidence: 'verified',
      context: { engineVersion: '1.0.0' },
    });
    expect(withoutFingerprint).toContain('evidence_fingerprint: unknown');
  });

  it('warns against hand editing', async () => {
    const files = renderAll(await runOn(path.join(FIXTURES, 'express-service')));
    expect(fileNamed(files, 'routes.md')).toContain('Do not edit by hand');
  });
});

// ── determinism ──────────────────────────────────────────────────────────────

describe('byte determinism', () => {
  it.each(['express-service', 'prisma-app', 'jobs-service', 'next-app'])(
    'renders identical bytes across runs on %s',
    async (fixture) => {
      const root = path.join(FIXTURES, fixture);
      const first = renderAll(await runOn(root));
      const second = renderAll(await runOn(root));

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    },
  );

  it('contains no Windows line endings', async () => {
    const files = renderAll(await runOn(path.join(FIXTURES, 'express-service')));
    for (const file of files) expect(file.contents).not.toContain('\r\n');
  });

  it('does not drift after generated pages are committed', async () => {
    const root = await copyFixture('express-service');
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root });
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'source'], { cwd: root });

    const before = renderAll(await runOn(root));
    await writeAll(await runOn(root));
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'generated docs'], { cwd: root });
    const after = renderAll(await runOn(root));

    expect(after).toEqual(before);
  });

  it('emits POSIX paths in links regardless of host platform', async () => {
    const files = renderAll(await runOn(path.join(FIXTURES, 'express-service')));
    expect(fileNamed(files, 'api.md')).not.toMatch(/\]\([^)]*\\/);
  });
});

// ── source links ─────────────────────────────────────────────────────────────

describe('source links', () => {
  it.each([
    ['docs/generated', '../../'],
    ['docs', '../'],
    ['', './'],
  ])('computes the path back to the repo root from %s', (outDir, expected) => {
    expect(pathToRepoRoot(outDir)).toBe(expected);
  });

  it('links to a line so a claim can be checked in one click', () => {
    expect(sourceLink({ file: 'src/a.ts', line: 42 }, 'docs/generated')).toBe(
      '[src/a.ts:42](../../src/a.ts#L42)',
    );
  });

  it('omits the fragment when there is no line', () => {
    expect(sourceLink({ file: 'src/a.ts' }, 'docs/generated')).toBe('[src/a.ts](../../src/a.ts)');
  });

  it('gives every endpoint row a source link', async () => {
    const files = renderAll(await runOn(path.join(FIXTURES, 'express-service')));
    const rows = fileNamed(files, 'api.md')
      .split('\n')
      .filter((line) => line.startsWith('| `GET`') || line.startsWith('| `POST`'));

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatch(/\]\(\.\.\/\.\.\/[^)]+#L\d+\)/);
  });
});

// ── honesty of empty output ──────────────────────────────────────────────────

describe('empty sections state why they are empty', () => {
  // An empty page could mean the technology is absent, unsupported, or genuinely
  // has nothing. A reader cannot tell unless it is stated.
  it('explains an inapplicable section rather than rendering a blank page', async () => {
    const files = renderAll(await runOn(path.join(FIXTURES, 'prisma-app')));
    const jobs = fileNamed(files, 'jobs.md');

    expect(jobs).toContain('No jobs were found in this repository');
    expect(jobs).toContain('No queue consumer, cron schedule, or scheduled workflow was found');
  });

  it('warns on a page whose technology docgen cannot read', async () => {
    const files = renderAll(await runOn(path.join(FIXTURES, 'monorepo')));

    expect(fileNamed(files, 'README.md')).toContain('This documentation is **incomplete**');
    expect(fileNamed(files, 'README.md')).toContain('Flask');
  });

  it('never claims a route is public when guards are undetermined', async () => {
    const files = renderAll(await runOn(path.join(FIXTURES, 'next-pages')));
    const routes = fileNamed(files, 'routes.md');

    expect(routes).toContain('That means *undetermined*, not *public*');
    expect(routes).toContain('_undetermined_');
  });

  it('renders gaps rather than hiding them', async () => {
    const files = renderAll(await runOn(path.join(FIXTURES, 'jobs-service')));
    const jobs = fileNamed(files, 'jobs.md');

    expect(jobs).toContain('Not determined');
    expect(jobs).toContain('queue-name-not-literal');
  });
});

describe('secret safety', () => {
  // config.md is committed to the repository.
  it('never renders a value from a .env file', async () => {
    const files = renderAll(await runOn(path.join(FIXTURES, 'config-app')));
    const config = fileNamed(files, 'config.md');

    expect(config).toContain('STRIPE_SECRET_KEY');
    expect(config).not.toContain('sk_test_donotcopy');
    expect(config).not.toContain('postgres://localhost/app');
  });

  it('separates read-but-undeclared from declared-but-unread', async () => {
    const config = fileNamed(renderAll(await runOn(path.join(FIXTURES, 'config-app'))), 'config.md');

    expect(config).toContain('Read but never declared');
    expect(config).toContain('Declared but never read');
  });
});

describe('heuristic entries are badged', () => {
  // SPEC 6.1: a regex-derived entry is lower certainty than an AST read, and a
  // reader must be able to see which is which.
  it('marks Python-derived tables', async () => {
    const schema = fileNamed(renderAll(await runOn(path.join(FIXTURES, 'python-app'))), 'schema.md');
    expect(schema).toContain('~heuristic');
  });

  it('does not badge an AST-derived table', async () => {
    const schema = fileNamed(renderAll(await runOn(path.join(FIXTURES, 'prisma-app'))), 'schema.md');
    expect(schema).not.toContain('~heuristic');
  });
});

// ── diagrams ─────────────────────────────────────────────────────────────────

describe('diagrams', () => {
  it('renders a route tree', async () => {
    const files = renderAll(await runOn(path.join(FIXTURES, 'next-app')));
    const sitemap = fileNamed(files, 'sitemap.mmd');

    expect(sitemap).toMatch(/^%% Generated by docgen/);
    expect(sitemap).toContain('graph TD');
    expect(sitemap).toContain('root -->');
  });

  it('renders an erDiagram with keys', async () => {
    const erd = fileNamed(renderAll(await runOn(path.join(FIXTURES, 'prisma-app'))), 'erd.mmd');

    expect(erd).toContain('erDiagram');
    expect(erd).toMatch(/\bPK\b/);
  });

  it('escapes quotes in labels so mermaid still parses', () => {
    const sitemap = renderSitemap(
      {
        entries: [{ path: '/a"b', kind: 'page', params: [], layoutChain: [], guards: [] }],
      } as never,
      40,
    );
    expect(sitemap).not.toMatch(/\["[^"]*"[^"]*"\]/);
  });

  // SPEC 6.3: aggregate rather than emit a hairball.
  it('collapses the module graph past the node budget and says so', () => {
    const entries = Array.from({ length: 60 }, (_, index) => ({
      module: `src/feature${index}/file.ts`,
      imports: [`src/shared/util.ts`],
      externals: [],
    }));

    const diagram = renderModules({ entries, cycles: [] } as never, 40);

    expect(diagram).toContain('exceeded the 40-node budget');
    expect(diagram).toContain('collapsed to top-level directories');
  });

  it('annotates cycles in the module graph', () => {
    const diagram = renderModules(
      { entries: [{ module: 'a.ts', imports: ['b.ts'], externals: [] }], cycles: [['a.ts', 'b.ts']] } as never,
      40,
    );
    expect(diagram).toContain('import cycle(s) detected');
  });

  it('identifies external services from SDK imports and env names', () => {
    const diagram = renderIntegrations({
      deps: { entries: [{ module: 'a.ts', imports: [], externals: ['stripe'] }] } as never,
      config: { entries: [{ name: 'TWILIO_SID', reads: [], declarations: [] }] } as never,
      projectName: 'svc',
    });

    expect(diagram).toContain('Stripe');
    expect(diagram).toContain('Twilio');
  });

  it('says so plainly when a diagram has nothing to show', () => {
    expect(renderErd(undefined, 40)).toContain('NO_SCHEMA_EXTRACTED');
    expect(renderSitemap(undefined, 40)).toContain('No routes were extracted');
  });
});

// ── writing ──────────────────────────────────────────────────────────────────

describe('writing to disk', () => {
  it('writes every rendered file', async () => {
    const root = await copyFixture('express-service');
    const report = await writeAll(await runOn(root));

    for (const file of report.written) {
      await expect(fs.stat(path.join(root, file))).resolves.toBeDefined();
    }
    expect(report.written).toContain('docs/generated/api.md');
  });

  it('produces identical bytes on a rewrite', async () => {
    const root = await copyFixture('express-service');

    await writeAll(await runOn(root));
    const first = await fs.readFile(path.join(root, 'docs/generated/api.md'), 'utf8');
    await writeAll(await runOn(root));
    const second = await fs.readFile(path.join(root, 'docs/generated/api.md'), 'utf8');

    expect(second).toBe(first);
  });

  it('marks the output as generated in .gitattributes', async () => {
    const root = await copyFixture('express-service');
    await writeAll(await runOn(root));

    const attributes = await fs.readFile(path.join(root, '.gitattributes'), 'utf8');
    expect(attributes).toContain('docs/generated/** linguist-generated=true');
  });

  it('does not duplicate an existing .gitattributes entry', async () => {
    const root = await copyFixture('express-service');

    expect(await ensureGitattributes(root, 'docs/generated')).toBe(true);
    expect(await ensureGitattributes(root, 'docs/generated')).toBe(false);

    const attributes = await fs.readFile(path.join(root, '.gitattributes'), 'utf8');
    expect(attributes.split('linguist-generated').length - 1).toBe(1);
  });

  it('preserves existing .gitattributes content', async () => {
    const root = await copyFixture('express-service');
    await fs.writeFile(path.join(root, '.gitattributes'), '* text=auto eol=lf\n', 'utf8');

    await ensureGitattributes(root, 'docs/generated');

    const attributes = await fs.readFile(path.join(root, '.gitattributes'), 'utf8');
    expect(attributes).toContain('* text=auto eol=lf');
    expect(attributes).toContain('linguist-generated=true');
  });
});

// ── table helper ─────────────────────────────────────────────────────────────

describe('table rendering', () => {
  it('escapes pipes so a cell cannot break the table', () => {
    const rendered = table([{ header: 'A', render: (row: { a: string }) => row.a }], [{ a: 'x|y' }]);
    expect(rendered).toContain('x|y');
  });

  it('says none rather than rendering an empty table', () => {
    expect(table([{ header: 'A', render: () => '' }], [])).toBe('_None._\n');
  });
});
