import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderBehaviourIndex, renderBehaviourPage } from '../src/infer/behaviour.js';
import { writeBehaviourPages } from '../src/infer/write-behaviour.js';
import { featureCardSchema } from '../src/infer/types.js';
import type { FeatureCard } from '../src/infer/types.js';
import type { SurfaceAnswers } from '../src/questions/store.js';
import type { GenerationContext } from '../src/types/core.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-behaviour-'));
  created.push(dir);
  return dir;
}

const context: GenerationContext = { engineVersion: '0.1.0', sourceCommit: 'abc123' };

function card(overrides: Partial<FeatureCard> = {}): FeatureCard {
  return {
    surfaceId: 'screen:/checkout',
    slug: 'checkout',
    title: '/checkout',
    kind: 'screen',
    body: featureCardSchema.parse({
      summary: { text: 'Collects payment details.', evidence: [{ file: 'src/checkout.tsx', line: 12 }] },
      userVisibleBehaviour: [
        { text: 'Shows a card form.', evidence: [{ file: 'src/checkout.tsx', line: 40 }] },
      ],
      states: [],
      edgeCases: [],
      unknowns: [
        {
          id: 'retry-policy',
          question: 'What happens when the provider times out?',
          why: 'No timeout handling is visible.',
          options: ['Retried automatically', 'User must resubmit'],
        },
        {
          id: 'currency',
          question: 'Which currencies are supported?',
          why: 'No currency list appears in this surface.',
        },
      ],
    }),
    producedBy: 'claude',
    inputHash: 'hash',
    promptVersion: 'feature-card.v1',
    answered: [],
    ...overrides,
  };
}

const answers: SurfaceAnswers = {
  surfaceId: 'screen:/checkout',
  slug: 'checkout',
  answers: [
    {
      questionId: 'retry-policy',
      question: 'What happens when the provider times out?',
      answer: 'The user must resubmit.',
      answeredBy: 'dev@example.com',
      answeredAt: '2026-01-15T09:30:00.000Z',
    },
  ],
};

describe('behaviour page trust lanes', () => {
  it('badges every model claim as inferred', () => {
    const page = renderBehaviourPage({
      card: card(),
      answers: undefined,
      context,
      outDir: 'docs/generated',
    });

    expect(page).toContain('`inferred` Collects payment details.');
    expect(page).toContain('`inferred` Shows a card form.');
  });

  it('never labels an unanswered surface as verified', () => {
    const page = renderBehaviourPage({
      card: card(),
      answers: undefined,
      context,
      outDir: 'docs/generated',
    });

    expect(page).not.toContain('`verified`');
  });

  it('states at file level that the page is inferred, even with answers present', () => {
    const page = renderBehaviourPage({ card: card(), answers, context, outDir: 'docs/generated' });
    expect(page).toContain('confidence: inferred');
  });

  it('shows a recorded answer as verified and names who gave it', () => {
    const page = renderBehaviourPage({ card: card(), answers, context, outDir: 'docs/generated' });

    expect(page).toContain('`verified` **What happens when the provider times out?**');
    expect(page).toContain('The user must resubmit.');
    expect(page).toContain('dev@example.com');
    expect(page).toContain('2026-01-15');
  });

  it('moves an answered question out of the open queue', () => {
    const page = renderBehaviourPage({ card: card(), answers, context, outDir: 'docs/generated' });

    expect(page).toContain('Open questions (1)');
    expect(page).toContain('Which currencies are supported?');
    // Present as an answer, absent as an open question.
    expect(page).not.toContain('### `unknown` What happens when the provider times out?');
  });

  it('gives each open question the exact command that closes it', () => {
    const page = renderBehaviourPage({
      card: card(),
      answers: undefined,
      context,
      outDir: 'docs/generated',
    });

    expect(page).toContain('docgen answer checkout retry-policy <number>');
    // No options offered, so a number would mean nothing.
    expect(page).toContain('docgen answer checkout currency "your answer"');
  });

  it('links every claim back to the code it cites', () => {
    const page = renderBehaviourPage({
      card: card(),
      answers: undefined,
      context,
      outDir: 'docs/generated',
    });

    expect(page).toContain('[src/checkout.tsx:12](../../../src/checkout.tsx#L12)');
  });

  it('says a section is empty rather than omitting it', () => {
    const page = renderBehaviourPage({
      card: card(),
      answers: undefined,
      context,
      outDir: 'docs/generated',
    });

    expect(page).toContain('## States');
    expect(page).toContain('_The model identified none for this surface._');
  });

  it('warns the reader before any inferred content appears', () => {
    const page = renderBehaviourPage({
      card: card(),
      answers: undefined,
      context,
      outDir: 'docs/generated',
    });

    const warningAt = page.indexOf('has not been checked by anyone');
    const firstClaimAt = page.indexOf('Collects payment details.');
    expect(warningAt).toBeGreaterThan(-1);
    expect(warningAt).toBeLessThan(firstClaimAt);
  });

  it('points at bootstrap, not extract, as the way to regenerate', () => {
    const page = renderBehaviourPage({
      card: card(),
      answers: undefined,
      context,
      outDir: 'docs/generated',
    });
    expect(page).toContain('Regenerate with `docgen bootstrap`');
  });

  it('renders the same bytes for the same inputs', () => {
    const args = { card: card(), answers, context, outDir: 'docs/generated' } as const;
    expect(renderBehaviourPage(args)).toBe(renderBehaviourPage(args));
  });
});

describe('behaviour index', () => {
  it('counts open questions across surfaces', () => {
    const index = renderBehaviourIndex({
      cards: [card()],
      answers: new Map([['screen:/checkout', answers]]),
      context,
      outDir: 'docs/generated',
    });

    expect(index).toContain('1 open question across 1 surface; 1 answered.');
    expect(index).toContain('[/checkout](behaviour/checkout.md)');
  });

  it('says so plainly when nothing has been described yet', () => {
    const index = renderBehaviourIndex({
      cards: [],
      answers: new Map(),
      context,
      outDir: 'docs/generated',
    });
    expect(index).toContain('No surfaces have been described yet');
  });
});

describe('writing behaviour pages', () => {
  it('writes one page per card plus an index', async () => {
    const root = await tempRepo();
    const written = await writeBehaviourPages({
      root,
      outDir: 'docs/generated',
      cards: [card()],
      answers: new Map(),
      context,
    });

    expect(written).toEqual([
      'docs/generated/behaviour.md',
      'docs/generated/behaviour/checkout.md',
    ]);
  });

  it('removes a page whose surface no longer exists', async () => {
    const root = await tempRepo();
    await writeBehaviourPages({
      root,
      outDir: 'docs/generated',
      cards: [card(), card({ surfaceId: 'screen:/cart', slug: 'cart', title: '/cart' })],
      answers: new Map(),
      context,
    });

    await writeBehaviourPages({
      root,
      outDir: 'docs/generated',
      cards: [card()],
      answers: new Map(),
      context,
    });

    const remaining = await fs.readdir(path.join(root, 'docs/generated/behaviour'));
    expect(remaining).toEqual(['checkout.md']);
  });

  it('writes LF endings regardless of platform', async () => {
    const root = await tempRepo();
    await writeBehaviourPages({
      root,
      outDir: 'docs/generated',
      cards: [card()],
      answers: new Map(),
      context,
    });

    const contents = await fs.readFile(
      path.join(root, 'docs/generated/behaviour/checkout.md'),
      'utf8',
    );
    expect(contents).not.toContain('\r\n');
  });
});
