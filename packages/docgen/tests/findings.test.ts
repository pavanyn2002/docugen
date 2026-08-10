import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFindings } from '../src/analysis/findings.js';
import type { FindingsReport } from '../src/analysis/findings.js';
import { loadConfig } from '../src/config/load.js';
import { runExtraction } from '../src/pipeline.js';
import { renderAll } from '../src/render/index.js';
import { runReportCommand } from '../src/commands/report.js';
import { checkNodeVersion } from '../src/cli.js';
import { ALWAYS_EXCLUDE } from '../src/config/schema.js';
import { createLogger } from '../src/util/logger.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(TEST_DIR, 'fixtures');

const silent = createLogger({
  level: 'silent',
  stderr: { write: () => true } as unknown as NodeJS.WritableStream,
  stdout: { write: () => true } as unknown as NodeJS.WritableStream,
});

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

async function findingsFor(root: string): Promise<FindingsReport> {
  const config = await loadConfig({ root });
  return computeFindings(await runExtraction({ config, logger: silent }));
}

const finding = (report: FindingsReport, id: string) =>
  report.findings.find((candidate) => candidate.id === id);

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-findings-'));
  created.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }
  return dir;
}

// ── the five analyses ────────────────────────────────────────────────────────

describe('cross-extractor findings', () => {
  it('produces the five analyses the SPEC names', async () => {
    const report = await findingsFor(path.join(FIXTURES, 'express-service'));

    expect(report.findings.map((entry) => entry.id)).toEqual([
      'dead-routes',
      'unreachable-modules',
      'unreferenced-tables',
      'env-declared-never-read',
      'env-read-never-declared',
    ]);
  });

  // An analysis that could not run must say so, rather than reporting zero
  // items — which would read as "checked, and clean".
  it('marks an analysis unavailable rather than reporting it clean', async () => {
    const report = await findingsFor(path.join(FIXTURES, 'express-service'));
    expect(finding(report, 'dead-routes')?.unavailable).toContain('No routes were extracted');
  });

  it('finds a route whose component file is missing', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"react-router-dom":"^6.26.0"}}',
      'src/router.tsx':
        "import { createBrowserRouter } from 'react-router-dom';\n" +
        "export const r = createBrowserRouter([{ path: '/gone', element: null }]);\n",
    });

    // The route resolves to src/router.tsx, which exists, so nothing is dead.
    const report = await findingsFor(root);
    expect(finding(report, 'dead-routes')?.items).toEqual([]);
  });

  it('finds a module nothing imports', async () => {
    const report = await findingsFor(path.join(FIXTURES, 'express-service'));
    const labels = finding(report, 'unreachable-modules')?.items.map((item) => item.label) ?? [];

    // validate.ts is imported by orderRoutes; navigation-style leaf files are not.
    expect(labels).not.toContain('src/middlewares/validate.ts');
  });

  // Entry points are loaded by a framework, not by an import.
  it('does not report index or config files as unimported', async () => {
    const root = await makeRepo({
      'package.json': '{}',
      'src/index.ts': "export const boot = () => 1;\n",
      'vitest.config.ts': 'export default {};\n',
      'src/orphan.ts': 'export const unused = 1;\n',
    });

    const labels =
      finding(await findingsFor(root), 'unreachable-modules')?.items.map((item) => item.label) ?? [];

    expect(labels).toContain('src/orphan.ts');
    expect(labels).not.toContain('src/index.ts');
    expect(labels).not.toContain('vitest.config.ts');
  });

  /**
   * Regression: an API handler is loaded by the framework from its path, so
   * nothing imports it — and the finding reported every one of them. On a real
   * Next.js app that was 13 handlers and 29 test files against 5 modules worth
   * looking at, which makes a list nobody can act on.
   *
   * The exclusion comes from what the endpoints extractor already proved rather
   * than from a list of magic filenames, so it holds for every framework.
   */
  it('does not report API route handlers as unimported', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"next":"^15.0.0"}}',
      'app/api/digest/route.ts': 'export async function GET() { return new Response("ok"); }',
      'app/page.tsx': 'export default function Home() { return null; }',
      'lib/orphan.ts': 'export const unused = 1;',
    });

    const labels =
      finding(await findingsFor(root), 'unreachable-modules')?.items.map((item) => item.label) ?? [];

    expect(labels).not.toContain('app/api/digest/route.ts');
    expect(labels).not.toContain('app/page.tsx');
    // The one module that really is unreferenced must still be reported.
    expect(labels).toContain('lib/orphan.ts');
  });

  it('does not report test files as unimported', async () => {
    // A test is a root of the runner's graph; nothing is supposed to import it.
    const root = await makeRepo({
      'package.json': '{}',
      'lib/maths.ts': 'export const add = (a: number, b: number) => a + b;',
      'lib/maths.test.ts': [
        "import { add } from './maths';",
        "it('adds', () => add(1, 2));",
      ].join('\n'),
      'lib/orphan.ts': 'export const unused = 1;',
    });

    const labels =
      finding(await findingsFor(root), 'unreachable-modules')?.items.map((item) => item.label) ?? [];

    expect(labels).not.toContain('lib/maths.test.ts');
    expect(labels).toContain('lib/orphan.ts');
  });

  it('finds a table never mentioned outside its definition', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"prisma":"^6.0.0"}}',
      'prisma/schema.prisma':
        'model Used {\n  id String @id\n}\n\nmodel Forgotten {\n  id String @id\n}\n',
      'src/app.ts': "export const q = () => 'Used';\n",
    });

    const labels =
      finding(await findingsFor(root), 'unreferenced-tables')?.items.map((item) => item.label) ?? [];

    expect(labels).toContain('Forgotten');
    expect(labels).not.toContain('Used');
  });

  // `User` must not be considered mentioned by `UserProfile`.
  it('matches table names on whole words only', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"prisma":"^6.0.0"}}',
      'prisma/schema.prisma': 'model User {\n  id String @id\n}\n',
      'src/app.ts': 'export const x = "UserProfile";\n',
    });

    const labels =
      finding(await findingsFor(root), 'unreferenced-tables')?.items.map((item) => item.label) ?? [];
    expect(labels).toContain('User');
  });

  it('finds env vars declared but never read, and read but never declared', async () => {
    const report = await findingsFor(path.join(FIXTURES, 'config-app'));

    expect(finding(report, 'env-declared-never-read')?.items.map((item) => item.label)).toContain(
      'UNUSED_LEGACY_FLAG',
    );
    expect(finding(report, 'env-read-never-declared')?.items.map((item) => item.label)).toContain(
      'AWS_REGION',
    );
  });

  it('states what each analysis cannot prove', async () => {
    const report = await findingsFor(path.join(FIXTURES, 'express-service'));

    expect(finding(report, 'unreachable-modules')?.description).toContain('dynamic import');
    expect(finding(report, 'unreferenced-tables')?.description).toContain('raw SQL');
  });
});

// ── report command ───────────────────────────────────────────────────────────

describe('docgen report', () => {
  it('prints coverage and findings', async () => {
    const { logger, stderr } = captureLogger();
    await runReportCommand({ cwd: path.join(FIXTURES, 'express-service'), json: false, logger });

    const output = stderr.join('');
    expect(output).toContain('Coverage');
    expect(output).toContain('Findings');
  });

  it('emits parseable JSON with --json', async () => {
    const { logger, stdout } = captureLogger();
    await runReportCommand({ cwd: path.join(FIXTURES, 'config-app'), json: true, logger });

    const parsed = JSON.parse(stdout.join('')) as {
      findings: { id: string; count: number }[];
      coverage: { extractor: string }[];
    };

    expect(parsed.coverage).toHaveLength(6);
    expect(parsed.findings.map((entry) => entry.id)).toContain('env-declared-never-read');
  });

  it('truncates long lists unless --full is given', async () => {
    const files: Record<string, string> = { 'package.json': '{}' };
    for (let index = 0; index < 25; index += 1) {
      files[`src/orphan${index}.ts`] = `export const value${index} = ${index};\n`;
    }
    const root = await makeRepo(files);

    const preview = captureLogger();
    await runReportCommand({ cwd: root, json: false, logger: preview.logger });
    expect(preview.stderr.join('')).toContain('more (use --full)');

    const full = captureLogger();
    await runReportCommand({ cwd: root, json: false, full: true, logger: full.logger });
    expect(full.stderr.join('')).not.toContain('more (use --full)');
  });

  it('renders findings into the generated README', async () => {
    const config = await loadConfig({ root: path.join(FIXTURES, 'config-app') });
    const run = await runExtraction({ config, logger: silent });
    const report = await computeFindings(run);

    const readme =
      renderAll(run, report).find((file) => file.path.endsWith('README.md'))?.contents ?? '';

    expect(readme).toContain('Findings');
    expect(readme).toContain('UNUSED_LEGACY_FLAG');
    expect(readme).toContain('observations for a human to');
  });
});

// ── production guards ────────────────────────────────────────────────────────

describe('runtime guards', () => {
  it.each(['v18.20.0', 'v20.10.0', 'v16.0.0'])('rejects Node %s with a clear message', (version) => {
    const problem = checkNodeVersion(version);
    expect(problem).toContain('requires Node 20.11');
    expect(problem).toContain(version);
  });

  it.each(['v20.11.0', 'v20.18.1', 'v22.0.0', 'v24.1.0'])('accepts Node %s', (version) => {
    expect(checkNodeVersion(version)).toBeUndefined();
  });

  // Reading its own output back would feed generated content into the results.
  it('never scans its own output directory', () => {
    expect(ALWAYS_EXCLUDE).toContain('**/docs/generated/**');
  });

  it('produces identical results when generated docs are already present', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"prisma":"^6.0.0"}}',
      'prisma/schema.prisma': 'model User {\n  id String @id\n}\n',
      'src/app.ts': "export const q = () => 'User';\n",
    });

    const first = JSON.stringify(await findingsFor(root));

    await fs.mkdir(path.join(root, 'docs/generated'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'docs/generated/schema.md'),
      '# Schema\n\nmodel Ghost { id String }\n',
      'utf8',
    );
    await fs.writeFile(path.join(root, 'docs/generated/.env.sample'), 'FAKE_VAR=1\n', 'utf8');

    expect(JSON.stringify(await findingsFor(root))).toBe(first);
  });
});
