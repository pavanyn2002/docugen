import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractJsonObject, inferCards, parseCardBody, PROMPT_VERSION } from '../src/infer/cards.js';
import { loadCards, saveCards, renderCardFile } from '../src/infer/store.js';
import { featureCardSchema } from '../src/infer/types.js';
import type { FeatureCard } from '../src/infer/types.js';
import { buildSurfaceContext } from '../src/infer/context.js';
import { renderFacts } from '../src/infer/facts.js';
import { loadAnswers, recordAnswer, renderAnswersForPrompt } from '../src/questions/store.js';
import { buildQueue } from '../src/questions/queue.js';
import { resolveAnswerText } from '../src/commands/answer.js';
import { getBackend, resolveBackend } from '../src/agents/registry.js';
import { buildInvocation, pickExecutable } from '../src/agents/cli-backend.js';
import { DocgenError } from '../src/util/errors.js';
import { createLogger } from '../src/util/logger.js';
import type { AgentBackend, AgentOutcome, AgentRequest } from '../src/agents/types.js';
import type { Surface } from '../src/surface/types.js';

const created: string[] = [];

async function makeRepo(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-infer-'));
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

/** Silent logger: these tests assert on returned data, not on console noise. */
const quiet = createLogger({ level: 'error' });

/**
 * A backend that returns canned responses and counts calls, so cache reuse and
 * failure handling can be asserted without spending money or needing a CLI.
 */
function fakeBackend(responses: readonly AgentOutcome[]): AgentBackend & { calls: AgentRequest[] } {
  const calls: AgentRequest[] = [];
  return {
    id: 'fake',
    name: 'Fake backend',
    setupHint: 'n/a',
    calls,
    async isAvailable() {
      return true;
    },
    async run(request: AgentRequest) {
      calls.push(request);
      return responses[calls.length - 1] ?? { ok: false, reason: 'no more canned responses' };
    },
  };
}

function surface(overrides: Partial<Surface> = {}): Surface {
  return {
    id: 'screen:checkout',
    slug: 'checkout',
    title: 'Checkout',
    kind: 'screen',
    sourceFiles: ['src/checkout.tsx'],
    routes: [],
    supportingRoutes: [],
    endpoints: [],
    jobs: [],
    origin: 'derived',
    ...overrides,
  };
}

const VALID_CARD = {
  summary: { text: 'Collects payment details.', evidence: [{ file: 'src/checkout.tsx', line: 12 }] },
  userVisibleBehaviour: [
    { text: 'Shows a card form.', evidence: [{ file: 'src/checkout.tsx' }] },
  ],
  states: [],
  edgeCases: [],
  unknowns: [
    {
      id: 'retry-policy',
      question: 'What happens when the payment provider times out?',
      why: 'No timeout handling is visible in this surface.',
      options: ['Retried automatically', 'User must resubmit'],
    },
  ],
};

describe('feature card schema', () => {
  it('rejects a claim with no evidence', () => {
    const result = featureCardSchema.safeParse({
      ...VALID_CARD,
      summary: { text: 'Collects payment details.', evidence: [] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys rather than ignoring them', () => {
    const result = featureCardSchema.safeParse({ ...VALID_CARD, confidence: 0.9 });
    expect(result.success).toBe(false);
  });

  it('accepts a card whose only content is honest unknowns', () => {
    const result = featureCardSchema.safeParse({
      summary: { text: 'Unclear.', evidence: [{ file: 'src/a.ts' }] },
      unknowns: [{ id: 'purpose', question: 'What is this for?', why: 'No usage found.' }],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.unknowns[0]?.options).toEqual([]);
  });
});

describe('parsing model output', () => {
  it('finds the object inside a fenced code block and surrounding prose', () => {
    const text = `Here you go:\n\n\`\`\`json\n${JSON.stringify(VALID_CARD)}\n\`\`\`\n\nHope that helps.`;
    const parsed = parseCardBody(text);
    expect(parsed.ok).toBe(true);
  });

  it('is not confused by braces inside string values', () => {
    const json = '{"a":"} not the end {","b":1}';
    expect(extractJsonObject(`prefix ${json} suffix`)).toBe(json);
  });

  it('is not confused by an escaped quote inside a string', () => {
    const json = '{"a":"say \\"} \\" here","b":2}';
    expect(extractJsonObject(json)).toBe(json);
  });

  it('treats an unparseable response as a non-answer rather than salvaging prose', () => {
    const parsed = parseCardBody('This screen probably handles checkout and payments.');
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toMatch(/no JSON object/i);
  });

  it('reports which field failed validation', () => {
    const parsed = parseCardBody(
      JSON.stringify({ ...VALID_CARD, summary: { text: 'x', evidence: [] } }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toContain('summary.evidence');
  });
});

describe('surface context', () => {
  it('tells the model which files it was not shown', async () => {
    const root = await makeRepo({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
    });

    const context = await buildSurfaceContext({
      root,
      surface: surface({ sourceFiles: ['src/a.ts', 'src/b.ts'] }),
      bundle: {},
      limits: { maxFiles: 1, maxBytesPerFile: 1000, maxTotalBytes: 10_000 },
    });

    expect(context.includedFiles).toEqual(['src/a.ts']);
    expect(context.omittedFiles).toEqual(['src/b.ts']);
    expect(context.code).toContain('were not included');
    expect(context.code).toContain('record it as an unknown');
  });

  it('produces the same hash for the same inputs', async () => {
    const root = await makeRepo({ 'src/a.ts': 'export const a = 1;\n' });
    const limits = { maxFiles: 10, maxBytesPerFile: 1000, maxTotalBytes: 10_000 };
    const first = await buildSurfaceContext({ root, surface: surface(), bundle: {}, limits });
    const second = await buildSurfaceContext({ root, surface: surface(), bundle: {}, limits });
    expect(first.contentHash).toBe(second.contentHash);
  });

  it('changes the hash when the code changes', async () => {
    const root = await makeRepo({ 'src/checkout.tsx': 'export const a = 1;\n' });
    const limits = { maxFiles: 10, maxBytesPerFile: 1000, maxTotalBytes: 10_000 };
    const before = await buildSurfaceContext({ root, surface: surface(), bundle: {}, limits });
    await fs.writeFile(path.join(root, 'src/checkout.tsx'), 'export const a = 2;\n', 'utf8');
    const after = await buildSurfaceContext({ root, surface: surface(), bundle: {}, limits });
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it('does not present a missing guard as proof the route is public', () => {
    const route = {
      id: 'r1',
      extractionMethod: 'ast',
      certainty: 'certain',
      source: { file: 'src/checkout.tsx', line: 1 },
      path: '/checkout',
      kind: 'page',
      params: [],
      isCatchAll: false,
      layoutChain: [],
      guards: [],
    } as const;

    const facts = renderFacts(surface({ routes: ['r1'] }), {
      routes: { entries: [route], gaps: [], skips: [] } as never,
    });

    expect(facts).toContain('does NOT mean it is public');
  });
});

describe('inference run', () => {
  const limits = { maxFiles: 10, maxBytesPerFile: 4000, maxTotalBytes: 40_000 };

  it('produces a card from a valid response', async () => {
    const root = await makeRepo({ 'src/checkout.tsx': 'export const Checkout = () => null;\n' });
    const backend = fakeBackend([{ ok: true, text: JSON.stringify(VALID_CARD) }]);

    const result = await inferCards({
      root,
      surfaces: [surface()],
      bundle: {},
      answers: new Map(),
      backend,
      limits,
      timeoutMs: 1000,
      logger: quiet,
    });

    expect(result.cards).toHaveLength(1);
    expect(result.failures).toEqual([]);
    expect(result.cards[0]?.promptVersion).toBe(PROMPT_VERSION);
    expect(result.cards[0]?.producedBy).toBe('fake');
  });

  it('reuses an unchanged surface instead of paying for it again', async () => {
    const root = await makeRepo({ 'src/checkout.tsx': 'export const Checkout = () => null;\n' });
    const backend = fakeBackend([{ ok: true, text: JSON.stringify(VALID_CARD) }]);

    const first = await inferCards({
      root,
      surfaces: [surface()],
      bundle: {},
      answers: new Map(),
      backend,
      limits,
      timeoutMs: 1000,
      logger: quiet,
    });

    const second = await inferCards({
      root,
      surfaces: [surface()],
      bundle: {},
      answers: new Map(),
      backend,
      limits,
      timeoutMs: 1000,
      previous: new Map(first.cards.map((card) => [card.surfaceId, card])),
      logger: quiet,
    });

    expect(backend.calls).toHaveLength(1);
    expect(second.reused).toEqual(['screen:checkout']);
    expect(second.cards[0]?.inputHash).toBe(first.cards[0]?.inputHash);
  });

  it('re-runs a cached surface when --force is given', async () => {
    const root = await makeRepo({ 'src/checkout.tsx': 'export const Checkout = () => null;\n' });
    const response: AgentOutcome = { ok: true, text: JSON.stringify(VALID_CARD) };
    const backend = fakeBackend([response, response]);

    const first = await inferCards({
      root,
      surfaces: [surface()],
      bundle: {},
      answers: new Map(),
      backend,
      limits,
      timeoutMs: 1000,
      logger: quiet,
    });

    await inferCards({
      root,
      surfaces: [surface()],
      bundle: {},
      answers: new Map(),
      backend,
      limits,
      timeoutMs: 1000,
      previous: new Map(first.cards.map((card) => [card.surfaceId, card])),
      force: true,
      logger: quiet,
    });

    expect(backend.calls).toHaveLength(2);
  });

  it('re-runs when a recorded answer changes, so the answer reaches the card', async () => {
    const root = await makeRepo({ 'src/checkout.tsx': 'export const Checkout = () => null;\n' });
    const response: AgentOutcome = { ok: true, text: JSON.stringify(VALID_CARD) };
    const backend = fakeBackend([response, response]);

    const first = await inferCards({
      root,
      surfaces: [surface()],
      bundle: {},
      answers: new Map(),
      backend,
      limits,
      timeoutMs: 1000,
      logger: quiet,
    });

    const answers = new Map([
      [
        'screen:checkout',
        {
          surfaceId: 'screen:checkout',
          slug: 'checkout',
          answers: [
            {
              questionId: 'retry-policy',
              question: 'What happens on timeout?',
              answer: 'User must resubmit.',
              answeredBy: 'dev@example.com',
              answeredAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      ],
    ]);

    const second = await inferCards({
      root,
      surfaces: [surface()],
      bundle: {},
      answers,
      backend,
      limits,
      timeoutMs: 1000,
      previous: new Map(first.cards.map((card) => [card.surfaceId, card])),
      logger: quiet,
    });

    expect(backend.calls).toHaveLength(2);
    expect(backend.calls[1]?.prompt).toContain('User must resubmit.');
    expect(second.cards[0]?.answered).toEqual(['retry-policy']);
  });

  it('records a failure rather than emitting a card when the backend errors', async () => {
    const root = await makeRepo({ 'src/checkout.tsx': 'export const Checkout = () => null;\n' });
    const backend = fakeBackend([{ ok: false, reason: 'rate limited' }]);

    const result = await inferCards({
      root,
      surfaces: [surface()],
      bundle: {},
      answers: new Map(),
      backend,
      limits,
      timeoutMs: 1000,
      logger: quiet,
    });

    expect(result.cards).toEqual([]);
    expect(result.failures[0]?.reason).toBe('rate limited');
  });

  it('records a failure rather than emitting a card for unvalidatable output', async () => {
    const root = await makeRepo({ 'src/checkout.tsx': 'export const Checkout = () => null;\n' });
    const backend = fakeBackend([
      { ok: true, text: JSON.stringify({ summary: { text: 'It does checkout.', evidence: [] } }) },
    ]);

    const result = await inferCards({
      root,
      surfaces: [surface()],
      bundle: {},
      answers: new Map(),
      backend,
      limits,
      timeoutMs: 1000,
      logger: quiet,
    });

    expect(result.cards).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  it('honours maxSurfaces so a first run can be bounded', async () => {
    const root = await makeRepo({
      'src/checkout.tsx': 'export const Checkout = () => null;\n',
      'src/cart.tsx': 'export const Cart = () => null;\n',
    });
    const backend = fakeBackend([{ ok: true, text: JSON.stringify(VALID_CARD) }]);

    await inferCards({
      root,
      surfaces: [
        surface(),
        surface({ id: 'screen:cart', slug: 'cart', title: 'Cart', sourceFiles: ['src/cart.tsx'] }),
      ],
      bundle: {},
      answers: new Map(),
      backend,
      limits,
      timeoutMs: 1000,
      maxSurfaces: 1,
      logger: quiet,
    });

    expect(backend.calls).toHaveLength(1);
  });
});

describe('card store', () => {
  const card: FeatureCard = {
    surfaceId: 'screen:checkout',
    slug: 'checkout',
    title: 'Checkout',
    kind: 'screen',
    body: featureCardSchema.parse(VALID_CARD),
    producedBy: 'fake',
    inputHash: 'abc123',
    promptVersion: PROMPT_VERSION,
    answered: [],
  };

  it('round-trips a card through disk', async () => {
    const root = await makeRepo();
    const written = await saveCards(root, [card]);
    expect(written).toEqual(['docs/.cards/checkout.yaml']);

    const loaded = await loadCards(root);
    expect(loaded.get('screen:checkout')?.body.summary.text).toBe('Collects payment details.');
    expect(loaded.get('screen:checkout')?.inputHash).toBe('abc123');
  });

  it('writes the same bytes for the same card', async () => {
    expect(renderCardFile(card)).toBe(renderCardFile(card));
  });

  it('warns the reader that the file is inferred, not verified', () => {
    expect(renderCardFile(card)).toContain('not verified fact');
  });

  it('treats a card whose body no longer validates as absent, so it regenerates', async () => {
    const root = await makeRepo({
      'docs/.cards/broken.yaml': [
        'surfaceId: screen:broken',
        'slug: broken',
        'body:',
        '  summary:',
        '    text: Something',
        '    evidence: []',
        '',
      ].join('\n'),
    });

    await expect(loadCards(root)).resolves.toEqual(new Map());
  });

  it('fails loudly on a corrupt card file rather than silently skipping it', async () => {
    const root = await makeRepo({ 'docs/.cards/bad.yaml': 'body: [unclosed\n' });
    await expect(loadCards(root)).rejects.toThrow(DocgenError);
  });
});

describe('answers', () => {
  const answer = {
    questionId: 'retry-policy',
    question: 'What happens when the payment provider times out?',
    answer: 'The user must resubmit.',
    answeredBy: 'dev@example.com',
    answeredAt: '2026-01-01T00:00:00.000Z',
  };

  it('round-trips an answer through disk', async () => {
    const root = await makeRepo();
    await recordAnswer({ root, surfaceId: 'screen:checkout', slug: 'checkout', answer });

    const loaded = await loadAnswers(root);
    expect(loaded.get('screen:checkout')?.answers).toEqual([answer]);
  });

  it('replaces a re-answered question rather than appending a second answer', async () => {
    const root = await makeRepo();
    await recordAnswer({ root, surfaceId: 'screen:checkout', slug: 'checkout', answer });
    await recordAnswer({
      root,
      surfaceId: 'screen:checkout',
      slug: 'checkout',
      answer: { ...answer, answer: 'It retries twice.' },
    });

    const loaded = await loadAnswers(root);
    expect(loaded.get('screen:checkout')?.answers).toHaveLength(1);
    expect(loaded.get('screen:checkout')?.answers[0]?.answer).toBe('It retries twice.');
  });

  it('keeps answers to other questions when one is re-answered', async () => {
    const root = await makeRepo();
    await recordAnswer({ root, surfaceId: 'screen:checkout', slug: 'checkout', answer });
    await recordAnswer({
      root,
      surfaceId: 'screen:checkout',
      slug: 'checkout',
      answer: { ...answer, questionId: 'currency', answer: 'GBP only.' },
    });
    await recordAnswer({
      root,
      surfaceId: 'screen:checkout',
      slug: 'checkout',
      answer: { ...answer, answer: 'Changed my mind.' },
    });

    const loaded = await loadAnswers(root);
    expect(loaded.get('screen:checkout')?.answers.map((a) => a.questionId)).toEqual([
      'currency',
      'retry-policy',
    ]);
  });

  it('fails loudly on a corrupt answers file, because answers are ground truth', async () => {
    const root = await makeRepo({ 'docs/.answers/checkout.yaml': 'answers: [unclosed\n' });
    await expect(loadAnswers(root)).rejects.toThrow(DocgenError);
  });

  it('renders nothing rather than a fabricated placeholder when there are none', () => {
    expect(renderAnswersForPrompt([])).toBe('_None yet._');
  });
});

describe('question queue', () => {
  function cardWith(unknowns: readonly { id: string; question: string; why: string }[]): FeatureCard {
    return {
      surfaceId: 'screen:checkout',
      slug: 'checkout',
      title: 'Checkout',
      kind: 'screen',
      body: featureCardSchema.parse({ ...VALID_CARD, unknowns }),
      producedBy: 'fake',
      inputHash: 'h',
      promptVersion: PROMPT_VERSION,
      answered: [],
    };
  }

  it('drops questions that already have an answer', () => {
    const card = cardWith([
      { id: 'a', question: 'A?', why: 'unclear' },
      { id: 'b', question: 'B?', why: 'unclear' },
    ]);

    const queue = buildQueue({
      cards: [card],
      answers: new Map([
        [
          'screen:checkout',
          {
            surfaceId: 'screen:checkout',
            slug: 'checkout',
            answers: [
              {
                questionId: 'a',
                question: 'A?',
                answer: 'Yes.',
                answeredBy: 'dev@example.com',
                answeredAt: '',
              },
            ],
          },
        ],
      ]),
    });

    expect(queue.questions.map((q) => q.unknown.id)).toEqual(['b']);
  });

  it('orders deterministically by surface then question id', () => {
    const queue = buildQueue({
      cards: [cardWith([{ id: 'z', question: 'Z?', why: 'not determinable' }, { id: 'a', question: 'A?', why: 'not determinable' }])],
      answers: new Map(),
    });
    expect(queue.questions.map((q) => q.unknown.id)).toEqual(['a', 'z']);
  });

  it('attributes a question to whoever last touched the surface', () => {
    const queue = buildQueue({
      cards: [cardWith([{ id: 'a', question: 'A?', why: 'not determinable' }])],
      answers: new Map(),
      ownersBySurface: new Map([
        ['screen:checkout', { email: 'dev@example.com', file: 'src/checkout.tsx' }],
      ]),
    });
    expect(queue.questions[0]?.likelyOwner).toBe('dev@example.com');
    expect(queue.owners).toEqual(['dev@example.com']);
  });
});

describe('answer selection', () => {
  it('resolves a bare number to the offered option', () => {
    expect(resolveAnswerText('2', ['Retried', 'Resubmitted'])).toBe('Resubmitted');
  });

  it('uses free text verbatim', () => {
    expect(resolveAnswerText('  It retries twice.  ', ['a', 'b'])).toBe('It retries twice.');
  });

  it('rejects an out-of-range option rather than guessing', () => {
    expect(() => resolveAnswerText('7', ['a', 'b'])).toThrow(DocgenError);
  });

  it('says so when the question offered no options at all', () => {
    expect(() => resolveAnswerText('1', [])).toThrow(/no numbered options/);
  });
});

describe('spawning a CLI backend', () => {
  it('spawns a real executable directly', () => {
    const invocation = buildInvocation('C:\\bin\\claude.exe', ['-p']);
    expect(invocation).toEqual({ command: 'C:\\bin\\claude.exe', args: ['-p'], verbatim: false });
  });

  it('runs a .cmd shim through the interpreter, since Node cannot spawn one', () => {
    const invocation = buildInvocation('C:\\npm\\codex.cmd', ['exec', '-']);
    expect(invocation.command.toLowerCase()).toContain('cmd');
    expect(invocation.verbatim).toBe(true);
    expect(invocation.args).toEqual(['/d', '/s', '/c', '""C:\\npm\\codex.cmd" "exec" "-""']);
  });

  it('skips the extensionless shell script Windows lists beside the shim', () => {
    const output = 'C:\\npm\\codex\r\nC:\\npm\\codex.cmd\r\n';
    expect(pickExecutable(output, 'win32')).toBe('C:\\npm\\codex.cmd');
  });

  it('prefers a real executable over a shim when both are on PATH', () => {
    const output = 'C:\\npm\\tool.cmd\r\nC:\\bin\\tool.exe\r\n';
    expect(pickExecutable(output, 'win32')).toBe('C:\\bin\\tool.exe');
  });

  it('takes the first path on POSIX, where extensions carry no meaning', () => {
    expect(pickExecutable('/usr/local/bin/claude\n/usr/bin/claude\n', 'linux')).toBe(
      '/usr/local/bin/claude',
    );
  });

  it('reports nothing when the probe found nothing', () => {
    expect(pickExecutable('', 'win32')).toBeUndefined();
  });
});

describe('backend resolution', () => {
  it('errors on an unknown backend id', () => {
    expect(() => getBackend('nope' as never)).toThrow(DocgenError);
  });

  it('refuses to silently downgrade an explicitly configured backend', async () => {
    // 'api' is unavailable unless the optional SDK is installed, which it is
    // not in this workspace — an explicit choice must fail, not fall back.
    const backend = getBackend('api');
    if (await backend.isAvailable()) return;
    await expect(resolveBackend('api')).rejects.toThrow(/not available/);
  });
});
