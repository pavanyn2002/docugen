import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadRequirements,
  nextRequirementId,
  recordRequirement,
  renderRequirementsFile,
} from '../src/requirements/store.js';
import { buildPending } from '../src/requirements/pending.js';
import { countByKind, renderRequirementsPage } from '../src/requirements/render.js';
import type { SurfaceRequirements } from '../src/requirements/types.js';
import { featureCardSchema } from '../src/infer/types.js';
import type { FeatureCard } from '../src/infer/types.js';
import type { SurfaceAnswers } from '../src/questions/store.js';
import { DocgenError } from '../src/util/errors.js';
import type { GenerationContext } from '../src/types/core.js';

const created: string[] = [];

async function makeRepo(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-req-'));
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

const base = {
  surfaceId: 'screen:/checkout',
  slug: 'checkout',
  recordedBy: 'dev@example.com',
  recordedAt: '2026-02-01T10:00:00.000Z',
} as const;

function card(): FeatureCard {
  return {
    surfaceId: 'screen:/checkout',
    slug: 'checkout',
    title: '/checkout',
    kind: 'screen',
    body: featureCardSchema.parse({
      summary: { text: 'Checkout.', evidence: [{ file: 'src/checkout.tsx' }] },
      unknowns: [],
    }),
    producedBy: 'claude',
    inputHash: 'h',
    promptVersion: 'feature-card.v1',
    answered: [],
  };
}

function answersFor(questionIds: readonly string[]): ReadonlyMap<string, SurfaceAnswers> {
  return new Map([
    [
      'screen:/checkout',
      {
        surfaceId: 'screen:/checkout',
        slug: 'checkout',
        answers: questionIds.map((questionId) => ({
          questionId,
          question: `What about ${questionId}?`,
          answer: `Answer for ${questionId}.`,
          answeredBy: 'dev@example.com',
          answeredAt: '2026-01-01T00:00:00.000Z',
        })),
      },
    ],
  ]);
}

describe('requirement ids', () => {
  it('scopes ids to their surface so parallel triage cannot collide', () => {
    expect(nextRequirementId([], 'requirement', 'checkout')).toBe('REQ-checkout-01');
    expect(nextRequirementId([], 'bug', 'checkout')).toBe('BUG-checkout-01');
  });

  it('continues from the highest existing number', () => {
    const existing = [
      { id: 'REQ-checkout-01' },
      { id: 'REQ-checkout-07' },
    ];
    expect(nextRequirementId(existing, 'requirement', 'checkout')).toBe('REQ-checkout-08');
  });

  it('never reuses a number freed by a deletion', () => {
    // Only 03 remains; a test or ticket may still quote 01 and 02.
    const existing = [{ id: 'REQ-checkout-03' }];
    expect(nextRequirementId(existing, 'requirement', 'checkout')).toBe('REQ-checkout-04');
  });

  it('numbers each kind independently', () => {
    const existing = [{ id: 'REQ-checkout-05' }];
    expect(nextRequirementId(existing, 'bug', 'checkout')).toBe('BUG-checkout-01');
  });
});

describe('requirement store', () => {
  it('round-trips a recorded requirement', async () => {
    const root = await makeRepo();
    const recorded = await recordRequirement({
      ...base,
      root,
      kind: 'requirement',
      title: 'What happens on timeout?',
      statement: 'The user must resubmit.',
      questionId: 'retry-policy',
    });

    expect(recorded.id).toBe('REQ-checkout-01');

    const loaded = await loadRequirements(root);
    expect(loaded.get('screen:/checkout')?.requirements).toHaveLength(1);
    expect(loaded.get('screen:/checkout')?.requirements[0]?.statement).toBe('The user must resubmit.');
  });

  it('keeps the id when a question is re-triaged as the same kind', async () => {
    const root = await makeRepo();
    const first = await recordRequirement({
      ...base,
      root,
      kind: 'requirement',
      title: 'q',
      statement: 'one',
      questionId: 'retry-policy',
    });
    const second = await recordRequirement({
      ...base,
      root,
      kind: 'requirement',
      title: 'q',
      statement: 'two',
      questionId: 'retry-policy',
    });

    expect(second.id).toBe(first.id);
    const loaded = await loadRequirements(root);
    expect(loaded.get('screen:/checkout')?.requirements).toHaveLength(1);
  });

  it('issues a new id when a question is reclassified, so the id matches its kind', async () => {
    const root = await makeRepo();
    await recordRequirement({
      ...base,
      root,
      kind: 'requirement',
      title: 'q',
      statement: 'one',
      questionId: 'retry-policy',
    });
    const reclassified = await recordRequirement({
      ...base,
      root,
      kind: 'bug',
      title: 'q',
      statement: 'one',
      questionId: 'retry-policy',
    });

    expect(reclassified.id).toBe('BUG-checkout-01');
    const loaded = await loadRequirements(root);
    expect(loaded.get('screen:/checkout')?.requirements).toHaveLength(1);
  });

  it('fails loudly on a corrupt file rather than dropping a requirement', async () => {
    const root = await makeRepo({ 'docs/.requirements/checkout.yaml': 'requirements: [oops\n' });
    await expect(loadRequirements(root)).rejects.toThrow(DocgenError);
  });

  it('writes the same bytes for the same input', () => {
    const surface: SurfaceRequirements = {
      surfaceId: 'screen:/checkout',
      slug: 'checkout',
      requirements: [
        {
          id: 'REQ-checkout-01',
          kind: 'requirement',
          status: 'confirmed',
          title: 'q',
          statement: 's',
          questionId: 'qid',
          surfaceId: 'screen:/checkout',
          recordedBy: 'dev@example.com',
          recordedAt: '2026-02-01T10:00:00.000Z',
        },
      ],
    };
    expect(renderRequirementsFile(surface)).toBe(renderRequirementsFile(surface));
  });

  it('says ids are never reused, since a human may edit the file', () => {
    const surface: SurfaceRequirements = {
      surfaceId: 'screen:/checkout',
      slug: 'checkout',
      requirements: [],
    };
    expect(renderRequirementsFile(surface)).toContain('never reused');
  });
});

describe('pending queue', () => {
  it('lists answers that have not been classified', () => {
    const pending = buildPending({
      cards: [card()],
      answers: answersFor(['a', 'b']),
      requirements: new Map(),
    });

    expect(pending.map((item) => item.answer.questionId)).toEqual(['a', 'b']);
  });

  it('drops an answer once it has been triaged', () => {
    const pending = buildPending({
      cards: [card()],
      answers: answersFor(['a', 'b']),
      requirements: new Map([
        [
          'screen:/checkout',
          {
            surfaceId: 'screen:/checkout',
            slug: 'checkout',
            requirements: [
              {
                id: 'REQ-checkout-01',
                kind: 'requirement',
                status: 'confirmed',
                title: 'q',
                statement: 's',
                questionId: 'a',
                surfaceId: 'screen:/checkout',
                recordedBy: 'dev@example.com',
                recordedAt: '',
              },
            ],
          } satisfies SurfaceRequirements,
        ],
      ]),
    });

    expect(pending.map((item) => item.answer.questionId)).toEqual(['b']);
  });

  it('is empty when nothing has been answered', () => {
    expect(buildPending({ cards: [card()], answers: new Map(), requirements: new Map() })).toEqual([]);
  });
});

describe('requirements page', () => {
  const requirements: ReadonlyMap<string, SurfaceRequirements> = new Map([
    [
      'screen:/checkout',
      {
        surfaceId: 'screen:/checkout',
        slug: 'checkout',
        requirements: [
          {
            id: 'REQ-checkout-01',
            kind: 'requirement',
            status: 'confirmed',
            title: 'What happens on timeout?',
            statement: 'The user must resubmit.',
            questionId: 'retry-policy',
            surfaceId: 'screen:/checkout',
            recordedBy: 'dev@example.com',
            recordedAt: '2026-02-01T10:00:00.000Z',
          },
          {
            id: 'BUG-checkout-01',
            kind: 'bug',
            status: 'confirmed',
            title: 'Does the total include tax?',
            statement: 'It should, and it does not.',
            questionId: 'tax',
            surfaceId: 'screen:/checkout',
            recordedBy: 'dev@example.com',
            recordedAt: '2026-02-01T10:00:00.000Z',
          },
        ],
      },
    ],
  ]);

  it('is verified, because every line came from a named developer', () => {
    const page = renderRequirementsPage({ requirements, context, pendingCount: 0 });
    expect(page).toContain('confidence: verified');
    expect(page).toContain('Nothing here was written by a model');
  });

  it('separates defects from intended behaviour', () => {
    const page = renderRequirementsPage({ requirements, context, pendingCount: 0 });
    expect(page).toContain('Intended behaviour (1)');
    expect(page).toContain('Defect (1)');
  });

  it('states its own incompleteness when answers are still untriaged', () => {
    const page = renderRequirementsPage({ requirements, context, pendingCount: 3 });
    expect(page).toContain('This is incomplete. 3 answered questions have not been triaged');
  });

  it('claims nothing when nothing has been triaged', () => {
    const page = renderRequirementsPage({ requirements: new Map(), context, pendingCount: 0 });
    expect(page).toContain('Nothing has been triaged yet');
    expect(page).not.toContain('Intended behaviour');
  });

  it('attributes every entry', () => {
    const page = renderRequirementsPage({ requirements, context, pendingCount: 0 });
    expect(page).toContain('dev@example.com');
    expect(page).toContain('2026-02-01');
  });

  it('renders the same bytes for the same input', () => {
    const args = { requirements, context, pendingCount: 0 } as const;
    expect(renderRequirementsPage(args)).toBe(renderRequirementsPage(args));
  });

  it('counts by kind', () => {
    expect(countByKind(requirements)).toEqual({ requirement: 1, bug: 1, decision: 0, context: 0 });
  });
});
