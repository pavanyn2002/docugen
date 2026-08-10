// Mermaid needs a DOM to parse. vitest supplies one per file, which avoids
// mutating globals that Node 24 exposes as getter-only.
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/load.js';
import { runExtraction } from '../src/pipeline.js';
import { renderAll } from '../src/render/index.js';
import { safeNodeId, validateMermaid } from '../src/render/mermaid-validate.js';
import { renderErd, renderSitemap } from '../src/render/diagrams.js';
import { createLogger } from '../src/util/logger.js';
import type { SchemaResult } from '../src/types/entries.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(TEST_DIR, 'fixtures');

const silent = createLogger({
  level: 'silent',
  stderr: { write: () => true } as unknown as NodeJS.WritableStream,
  stdout: { write: () => true } as unknown as NodeJS.WritableStream,
});

/**
 * Every fixture that produces a meaningfully different diagram shape:
 * dynamic route segments, relations, a collapsed graph, external services.
 */
const FIXTURE_NAMES = [
  'next-app',
  'next-pages',
  'react-router',
  'prisma-app',
  'mongoose-service',
  'sql-migrations',
  'express-service',
  'jobs-service',
  'python-app',
  'monorepo',
  'plain-node',
];

interface Diagram {
  readonly fixture: string;
  readonly name: string;
  readonly contents: string;
}

const diagrams: Diagram[] = [];

beforeAll(async () => {
  for (const fixture of FIXTURE_NAMES) {
    const config = await loadConfig({ root: path.join(FIXTURES, fixture) });
    const run = await runExtraction({ config, logger: silent });
    for (const file of renderAll(run)) {
      if (!file.path.endsWith('.mmd')) continue;
      diagrams.push({ fixture, name: path.posix.basename(file.path), contents: file.contents });
    }
  }
}, 120_000);

/**
 * Parse with the real Mermaid, not a lookalike.
 *
 * A structural check of our own can only find the problems we thought of. A
 * diagram that fails to parse renders as an error box in GitHub, which makes
 * the whole documentation set look broken — so this runs the actual parser
 * that GitHub runs.
 */
async function parseWithMermaid(source: string): Promise<void> {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  await mermaid.parse(source);
}

describe('generated diagrams parse with the real Mermaid', () => {
  it('collected diagrams from every fixture', () => {
    expect(diagrams.length).toBeGreaterThanOrEqual(FIXTURE_NAMES.length * 4);
  });

  it('every generated diagram parses', async () => {
    const failures: string[] = [];

    for (const diagram of diagrams) {
      try {
        await parseWithMermaid(diagram.contents);
      } catch (error) {
        failures.push(
          `${diagram.fixture}/${diagram.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    expect(failures).toEqual([]);
  }, 120_000);

  // Next.js dynamic segments put brackets in almost every route label, and an
  // unescaped `]` closes the node shape early.
  it('parses a route label containing square brackets', async () => {
    const sitemap = renderSitemap(
      {
        entries: [
          { path: '/orders/[id]', kind: 'page', params: ['id'], layoutChain: [], guards: [] },
          { path: '/blog/[...slug]', kind: 'page', params: ['slug'], layoutChain: [], guards: [] },
        ],
      } as never,
      40,
    );

    expect(sitemap).not.toMatch(/\["[^"]*\[/);
    await expect(parseWithMermaid(sitemap)).resolves.toBeUndefined();
  });

  it('parses labels containing quotes, parentheses, and braces', async () => {
    const sitemap = renderSitemap(
      {
        entries: [
          { path: '/a"b', kind: 'page', params: [], layoutChain: [], guards: [] },
          { path: '/(marketing)/x', kind: 'page', params: [], layoutChain: [], guards: [] },
          { path: '/{tenant}/y', kind: 'page', params: [], layoutChain: [], guards: [] },
        ],
      } as never,
      40,
    );

    await expect(parseWithMermaid(sitemap)).resolves.toBeUndefined();
  });
});

describe('structural validator', () => {
  it('passes every generated diagram', () => {
    const failures = diagrams
      .map((diagram) => ({ diagram, problems: validateMermaid(diagram.contents) }))
      .filter((entry) => entry.problems.length > 0)
      .map((entry) => `${entry.diagram.fixture}/${entry.diagram.name}: ${entry.problems[0]?.message ?? ''}`);

    expect(failures).toEqual([]);
  });

  it('catches an unquoted label', () => {
    const problems = validateMermaid('graph TD\n  a[raw label]\n');
    expect(problems.map((problem) => problem.kind)).toContain('unquoted-label');
  });

  it('catches unbalanced quotes', () => {
    const problems = validateMermaid('graph TD\n  a["unterminated]\n');
    expect(problems.map((problem) => problem.kind)).toContain('unbalanced-quotes');
  });

  // `end` closes the enclosing subgraph and breaks the diagram silently.
  it('catches a reserved node id', () => {
    const problems = validateMermaid('graph TD\n  end["Finish"]\n');
    expect(problems.map((problem) => problem.kind)).toContain('reserved-node-id');
  });

  // Regression: identical `}` lines were once deduplicated away, leaving every
  // entity block after the first unterminated.
  it('catches an unclosed block', () => {
    const problems = validateMermaid(['erDiagram', '  a {', '    int id'].join('\n'));
    expect(problems.map((problem) => problem.kind)).toContain('unbalanced-block');
  });

  it('rejects an empty diagram', () => {
    expect(validateMermaid('').map((problem) => problem.kind)).toEqual(['empty-diagram']);
  });
});

describe('node ids', () => {
  it('suffixes a reserved word rather than dropping the node', () => {
    expect(safeNodeId('', 'end')).toBe('_end_node');
    expect(safeNodeId('r', 'end')).toBe('r_end');
  });

  it('produces a stable identifier from a path', () => {
    expect(safeNodeId('r', '/orders/[id]')).toBe('r_orders_id');
  });

  it('never produces an empty id', () => {
    expect(safeNodeId('m', '///')).toBe('m_root');
  });
});

describe('erd field truncation', () => {
  /**
   * Regression: a table wider than the field cap emitted `more 7_more_fields`.
   * Mermaid's ER grammar expects an ATTRIBUTE_WORD after the type and rejects
   * one starting with a digit, so a single wide table made the whole diagram
   * fail to parse — and GitHub renders that as an error block, not an ERD.
   *
   * Every in-repo fixture is narrower than the cap, which is exactly why no
   * existing test caught it and a real 27-column table did.
   */
  const wideTable = (fieldCount: number): SchemaResult => ({
    extractor: 'schema',
    applicable: true,
    detected: ['sql-ddl'],
    entries: [
      {
        id: 'schema:table:bugs',
        source: { file: 'migrations/0001.sql', line: 1 },
        extractionMethod: 'regex',
        certainty: 'low',
        name: 'bugs',
        kind: 'table',
        fields: Array.from({ length: fieldCount }, (_unused, index) => ({
          name: `field_${index}`,
          type: 'text',
        })),
        indexes: [],
        relations: [],
      },
    ],
    gaps: [],
    skips: [],
    durationMs: 0,
  });

  it('renders a table wider than the cap as a parseable diagram', async () => {
    const diagram = renderErd(wideTable(27), 40);
    expect(diagram).toContain('fields_not_shown_7');
    await expect(parseWithMermaid(diagram)).resolves.toBeUndefined();
  });

  it('leaves a table inside the cap untouched', () => {
    expect(renderErd(wideTable(20), 40)).not.toContain('fields_not_shown');
  });
});
