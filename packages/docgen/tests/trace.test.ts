import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/util/logger.js';
import { runTraceCommand } from '../src/commands/trace.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanTestReferences } from '../src/trace/scan.js';
import { buildMatrix, testCaseIdFor } from '../src/trace/matrix.js';
import { renderTestCasesPage, renderTraceabilityPage } from '../src/trace/render.js';
import { featureCardSchema } from '../src/infer/types.js';
import type { FeatureCard } from '../src/infer/types.js';
import type { Requirement, SurfaceRequirements } from '../src/requirements/types.js';
import type { GenerationContext } from '../src/types/core.js';

const created: string[] = [];

async function makeRepo(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-trace-'));
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

const context: GenerationContext = { engineVersion: '0.1.0', sourceCommit: 'abc123' };

function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: 'REQ-checkout-01',
    kind: 'requirement',
    status: 'confirmed',
    title: 'What happens on timeout?',
    statement: 'The user must resubmit.',
    questionId: 'retry-policy',
    surfaceId: 'screen:/checkout',
    recordedBy: 'dev@example.com',
    recordedAt: '2026-02-01T10:00:00.000Z',
    ...overrides,
  };
}

function requirementsMap(...items: readonly Requirement[]): ReadonlyMap<string, SurfaceRequirements> {
  return new Map([
    ['screen:/checkout', { surfaceId: 'screen:/checkout', slug: 'checkout', requirements: items }],
  ]);
}

function card(overrides: Partial<FeatureCard> = {}): FeatureCard {
  return {
    surfaceId: 'screen:/checkout',
    slug: 'checkout',
    title: '/checkout',
    kind: 'screen',
    body: featureCardSchema.parse({
      summary: { text: 'Checkout.', evidence: [{ file: 'src/checkout.tsx' }] },
      userVisibleBehaviour: [{ text: 'Shows a form.', evidence: [{ file: 'src/checkout.tsx' }] }],
      unknowns: [{ id: 'currency', question: 'Which currencies?', why: 'Not visible.' }],
    }),
    producedBy: 'claude',
    inputHash: 'h',
    promptVersion: 'feature-card.v1',
    answered: [],
    ...overrides,
  };
}

describe('scanning tests for requirement ids', () => {
  it('finds an id in a test name', async () => {
    const root = await makeRepo({
      'src/checkout.test.ts': "it('REQ-checkout-01: resubmits after timeout', () => {});\n",
    });

    const found = await scanTestReferences({ root });

    expect(found).toEqual([{ id: 'REQ-checkout-01', file: 'src/checkout.test.ts', line: 1 }]);
  });

  it('finds an id in a comment', async () => {
    const root = await makeRepo({
      'tests/orders_test.py': '# covers BUG-orders-02\ndef test_orders():\n    pass\n',
    });

    const found = await scanTestReferences({ root });

    expect(found[0]).toMatchObject({ id: 'BUG-orders-02', line: 1 });
  });

  it('finds every id when a test cites more than one', async () => {
    const root = await makeRepo({
      'a.spec.ts': "it('REQ-a-01 and REQ-a-02', () => {});\n",
    });

    expect((await scanTestReferences({ root })).map((r) => r.id)).toEqual(['REQ-a-01', 'REQ-a-02']);
  });

  it('ignores ids outside the test globs, so source comments are not miscounted', async () => {
    const root = await makeRepo({
      'src/checkout.ts': '// implements REQ-checkout-01\n',
    });

    expect(await scanTestReferences({ root })).toEqual([]);
  });

  it('does not match something that merely looks like an id', async () => {
    const root = await makeRepo({
      'a.test.ts': "it('REQUEST-01 and REQ-nodigits', () => {});\n",
    });

    expect(await scanTestReferences({ root })).toEqual([]);
  });

  it('orders deterministically', async () => {
    const root = await makeRepo({
      'b.test.ts': "it('REQ-a-01', () => {});\n",
      'a.test.ts': "it('REQ-a-01', () => {});\n",
    });

    expect((await scanTestReferences({ root })).map((r) => r.file)).toEqual([
      'a.test.ts',
      'b.test.ts',
    ]);
  });
});

describe('the traceability matrix', () => {
  it('links a requirement to the test citing it', () => {
    const matrix = buildMatrix({
      requirements: requirementsMap(requirement()),
      cards: [card()],
      references: [{ id: 'REQ-checkout-01', file: 'a.test.ts', line: 3 }],
      answers: new Map(),
    });

    expect(matrix.rows[0]?.references).toHaveLength(1);
    expect(matrix.untested).toEqual([]);
    expect(matrix.testedCount).toBe(1);
  });

  it('reports a requirement nothing cites', () => {
    const matrix = buildMatrix({
      requirements: requirementsMap(requirement()),
      cards: [card()],
      references: [],
      answers: new Map(),
    });

    expect(matrix.untested.map((row) => row.requirement.id)).toEqual(['REQ-checkout-01']);
  });

  it('reports a test citing an id that does not exist', () => {
    const matrix = buildMatrix({
      requirements: requirementsMap(requirement()),
      cards: [card()],
      references: [{ id: 'REQ-checkout-99', file: 'a.test.ts', line: 1 }],
      answers: new Map(),
    });

    expect(matrix.danglingReferences.map((r) => r.id)).toEqual(['REQ-checkout-99']);
    // A broken citation must not count as coverage.
    expect(matrix.testedCount).toBe(0);
  });

  it('reports a surface described but never confirmed', () => {
    const matrix = buildMatrix({
      requirements: new Map(),
      cards: [card()],
      references: [],
      answers: new Map(),
    });

    expect(matrix.untracedSurfaces.map((s) => s.slug)).toEqual(['checkout']);
    expect(matrix.untracedSurfaces[0]?.claimCount).toBe(2);
    expect(matrix.untracedSurfaces[0]?.openQuestions).toBe(1);
  });

  it('does not report a surface that has a confirmed requirement', () => {
    const matrix = buildMatrix({
      requirements: requirementsMap(requirement()),
      cards: [card()],
      references: [],
      answers: new Map(),
    });

    expect(matrix.untracedSurfaces).toEqual([]);
  });

  it('gives defects a test case too, since a fix needs a regression test', () => {
    const matrix = buildMatrix({
      requirements: requirementsMap(requirement({ id: 'BUG-checkout-01', kind: 'bug' })),
      cards: [card()],
      references: [],
      answers: new Map(),
    });

    expect(matrix.rows[0]?.testCaseId).toBe('TC-BUG-checkout-01');
  });

  it('does not demand a test for a decision or a note', () => {
    const matrix = buildMatrix({
      requirements: requirementsMap(
        requirement({ id: 'ADR-checkout-01', kind: 'decision' }),
        requirement({ id: 'CTX-checkout-01', kind: 'context' }),
      ),
      cards: [card()],
      references: [],
      answers: new Map(),
    });

    expect(matrix.testableCount).toBe(0);
    expect(matrix.untested).toEqual([]);
  });

  it('does not demand a test for a superseded requirement', () => {
    const matrix = buildMatrix({
      requirements: requirementsMap(requirement({ status: 'superseded' })),
      cards: [card()],
      references: [],
      answers: new Map(),
    });

    expect(matrix.untested).toEqual([]);
  });

  it('keeps a bug and a requirement of the same number apart', () => {
    expect(testCaseIdFor(requirement())).toBe('TC-REQ-checkout-01');
    expect(testCaseIdFor(requirement({ id: 'BUG-checkout-01', kind: 'bug' }))).toBe(
      'TC-BUG-checkout-01',
    );
  });
});

describe('the trace pages', () => {
  const matrix = buildMatrix({
    requirements: requirementsMap(requirement()),
    cards: [card()],
    references: [{ id: 'REQ-checkout-01', file: 'a.test.ts', line: 3 }],
    answers: new Map(),
  });

  it('never invents test steps', () => {
    const page = renderTestCasesPage({ matrix, context, outDir: 'docs/generated' });

    expect(page).toContain('to be written by whoever knows how to reach this state');
    expect(page).toContain('Steps are deliberately left blank');
  });

  it('is verified, because it derives only from confirmed requirements', () => {
    const page = renderTestCasesPage({ matrix, context, outDir: 'docs/generated' });
    expect(page).toContain('confidence: verified');
  });

  it('shows a developer how to link a test', () => {
    const page = renderTestCasesPage({ matrix, context, outDir: 'docs/generated' });
    expect(page).toContain("it('REQ-checkout-01:");
  });

  it('renders all three gap sections even when they are empty', () => {
    const clean = buildMatrix({
      requirements: requirementsMap(requirement()),
      cards: [card()],
      references: [{ id: 'REQ-checkout-01', file: 'a.test.ts', line: 3 }],
      answers: new Map(),
    });
    const page = renderTraceabilityPage({ matrix: clean, context, outDir: 'docs/generated' });

    // An omitted section reads as "no problem here" whether or not it was checked.
    expect(page).toContain('Requirements with no test (0)');
    expect(page).toContain('Tests citing an unknown requirement (0)');
    expect(page).toContain('Behaviour mapping to neither (0)');
  });

  it('reports coverage as a proportion of what is testable', () => {
    const page = renderTraceabilityPage({ matrix, context, outDir: 'docs/generated' });
    expect(page).toContain('1 of 1 testable requirements are cited by at least one test (100%)');
  });

  it('renders the same bytes for the same input', () => {
    const args = { matrix, context, outDir: 'docs/generated' } as const;
    expect(renderTraceabilityPage(args)).toBe(renderTraceabilityPage(args));
    expect(renderTestCasesPage(args)).toBe(renderTestCasesPage(args));
  });
});

describe('what `docgen trace` claims it wrote', () => {
  const created: string[] = [];

  async function makeRepo(files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-trace-cmd-'));
    created.push(dir);
    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(dir, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents, 'utf8');
    }
    return dir;
  }

  function captureLogger() {
    const lines: string[] = [];
    const sink = { write: (chunk: string) => (lines.push(chunk), true) };
    return {
      lines,
      logger: createLogger({
        level: 'info',
        stdout: sink as unknown as NodeJS.WritableStream,
        stderr: sink as unknown as NodeJS.WritableStream,
      }),
    };
  }

  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  /**
   * Regression: the closing line named both trace pages unconditionally, so a
   * repo with nothing triaged was told they had been written when no matrix
   * exists to render and neither file was created. Naming a file that is not
   * there is the same class of error the tool exists to catch.
   */
  it('does not name pages it did not write', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"next":"^15.0.0"}}',
      'app/page.tsx': 'export default function Home() { return null; }',
    });

    const { lines, logger } = captureLogger();
    await runTraceCommand({ cwd: root, logger });
    const output = lines.join('');

    expect(output).not.toContain('test-cases.md');
    expect(output).toContain('nothing written');
    await expect(fs.stat(path.join(root, 'docs/generated/test-cases.md'))).rejects.toThrow();
  });

  /**
   * The exclude list is assembled once in loadConfig. Rebuilding it by hand
   * here dropped the repo's own .gitignore, so a fixture inside an ignored
   * directory was scanned for requirement citations.
   */
  it('does not scan tests inside a gitignored directory', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"next":"^15.0.0"}}',
      'app/page.tsx': 'export default function Home() { return null; }',
      '.gitignore': '/output/\n',
      'output/copy.test.ts': "it('REQ-ghost-01: a stale copy', () => {});",
    });

    const { lines, logger } = captureLogger();
    await runTraceCommand({ cwd: root, json: true, logger });
    const payload = JSON.parse(lines.join('')) as {
      danglingReferences: readonly unknown[];
      testFilesScanned: number;
    };

    expect(payload.testFilesScanned).toBe(0);
    expect(payload.danglingReferences).toEqual([]);
  });
});
