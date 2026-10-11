import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAnswers, recordAnswer } from '../src/questions/store.js';
import { loadRequirements, recordRequirement } from '../src/requirements/store.js';
import { findBoundaryViolations } from '../src/util/boundaries.js';

const roots: string[] = [];
const identity = { surfaceId: 'screen:checkout', slug: 'checkout' };
const date = '2026-10-12T00:00:00.000Z';
const answer = { questionId: 'tax', question: 'Tax?', answer: 'Included', answeredBy: 'dev@example.com', answeredAt: date };
const requirement = { ...identity, kind: 'requirement' as const, title: 'Tax?', statement: 'Included', questionId: 'tax', recordedBy: 'dev@example.com', recordedAt: date };
const storedRequirement = { id: 'REQ-checkout-01', kind: 'requirement', title: 'Tax?', statement: 'Included', questionId: 'tax', recordedBy: 'dev@example.com', recordedAt: date, status: 'confirmed' };

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-human-reliability-'));
  roots.push(root);
  return root;
}

async function write(root: string, relative: string, value: unknown): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, YAML.stringify(value));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('human record validation', () => {
  it.each([null, 'text', {}, { surfaceId: 1 }, { ...identity, answers: 'wrong' },
    { ...identity, answers: [{ ...answer, answer: 123 }] },
    { ...identity, answers: [{ ...answer, answeredAt: 123 }] },
    { ...identity, answers: [answer, answer] },
  ])('rejects malformed answer data %# instead of dropping it', async value => {
    const root = await repo();
    await write(root, 'docs/.answers/checkout.yaml', value);
    await expect(loadAnswers(root)).rejects.toMatchObject({ code: 'answers-invalid', file: 'docs/.answers/checkout.yaml' });
  });

  it.each([null, 'text', {}, { surfaceId: 1 }, { ...identity, requirements: 'wrong' },
    { ...identity, requirements: [{ ...storedRequirement, statement: 123 }] },
    { ...identity, requirements: [{ ...storedRequirement, kind: 'typo' }] },
    { ...identity, requirements: [{ ...storedRequirement, status: 'typo' }] },
  ])('rejects malformed requirement data %# instead of dropping it', async value => {
    const root = await repo();
    await write(root, 'docs/.requirements/checkout.yaml', value);
    await expect(loadRequirements(root)).rejects.toMatchObject({ code: 'requirements-invalid', file: 'docs/.requirements/checkout.yaml' });
  });

  it.each(['answers', 'requirements'] as const)('rejects duplicate %s surfaces', async kind => {
    const root = await repo();
    for (const extension of ['yaml', 'yml']) await write(root, `docs/.${kind}/checkout.${extension}`, { ...identity, [kind]: [] });
    await expect(kind === 'answers' ? loadAnswers(root) : loadRequirements(root)).rejects.toMatchObject({ code: `${kind}-duplicate-surface` });
  });
});

describe('atomic human record publication', () => {
  it.each(['answers', 'requirements'] as const)('preserves previous %s bytes if publication fails', async kind => {
    const root = await repo();
    const publish = () => kind === 'answers'
      ? recordAnswer({ root, ...identity, answer })
      : recordRequirement({ root, ...requirement });
    await publish();
    const file = path.join(root, `docs/.${kind}/checkout.yaml`);
    const before = await fs.readFile(file, 'utf8');
    const failure = new Error('publication interrupted');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(failure);
    await expect(publish()).rejects.toBe(failure);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect((await fs.readdir(path.dirname(file))).filter(name => name.includes('.docgen-tmp-'))).toEqual([]);
  });

  it.each(['answers', 'requirements'] as const)('updates an existing %s .yml file in place', async kind => {
    const root = await repo();
    const relative = `docs/.${kind}/checkout.yml`;
    await write(root, relative, { ...identity, [kind]: [] });
    if (kind === 'answers') await recordAnswer({ root, ...identity, answer });
    else await recordRequirement({ root, ...requirement });
    const data = YAML.parse(await fs.readFile(path.join(root, relative), 'utf8')) as Record<string, unknown[]>;
    expect(data[kind]).toHaveLength(1);
    await expect(fs.stat(path.join(root, `docs/.${kind}/checkout.yaml`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('durable requirement identities', () => {
  it.each(['highest-entry', 'whole-file'] as const)('never reuses an id after deleting the %s', async deletion => {
    const root = await repo();
    const first = await recordRequirement({ root, ...requirement });
    const relative = 'docs/.requirements/checkout.yaml';
    if (deletion === 'whole-file') await fs.unlink(path.join(root, relative));
    else await write(root, relative, { ...identity, requirements: [] });
    const next = await recordRequirement({ root, ...requirement, questionId: 'new-tax' });
    expect(first.id).toBe('REQ-checkout-01');
    expect(next.id).toBe('REQ-checkout-02');
  });

  it('reserves existing legacy ids before a reclassification removes them', async () => {
    const root = await repo();
    await write(root, 'docs/.requirements/checkout.yaml', { ...identity, requirements: [{ ...storedRequirement, id: 'REQ-checkout-07' }] });
    await recordRequirement({ root, ...requirement, kind: 'bug' });
    const next = await recordRequirement({ root, ...requirement, questionId: 'new-tax' });
    expect(next.id).toBe('REQ-checkout-08');
  });
});

describe('syntax-aware trust boundary', () => {
  it.each([
    "import {\n  inferCards\n} from '../infer/cards.js';",
    "export {\n  inferCards\n} from '../infer/cards.js';",
    "const cards = import(\n  '../infer/cards.js'\n);",
    "const cards = require(\n  '../infer/cards.js'\n);",
    "import cards = require('../infer/cards.js');",
    "type Card = import('../infer/cards.js').Card;",
    "const cards = import(`../infer/cards.js`);",
  ])('detects forbidden multiline and alternate import syntax %#', async contents => {
    const root = await repo();
    await fs.mkdir(path.join(root, 'extract'));
    await fs.writeFile(path.join(root, 'extract/routes.ts'), contents);
    expect(await findBoundaryViolations(root)).toMatchObject([{ file: 'extract/routes.ts', line: 1, specifier: '../infer/cards.js' }]);
  });

  it('ignores import-looking text in comments and strings', async () => {
    const root = await repo();
    await fs.mkdir(path.join(root, 'extract'));
    await fs.writeFile(path.join(root, 'extract/routes.ts'), "// import '../infer/cards.js';\nconst example = \"import '../agents/api.js';\";\n");
    expect(await findBoundaryViolations(root)).toEqual([]);
  });
});
