import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAskCommand } from '../src/commands/ask.js';
import { saveCards } from '../src/infer/store.js';
import { recordAnswer } from '../src/questions/store.js';
import * as owners from '../src/questions/queue.js';
import type { Logger } from '../src/util/logger.js';
import { createRepository, homeCard } from './helpers/repository.js';

let root: string;
const messages: string[] = [];
const json: string[] = [];
const logger: Logger = {
  level: 'info', error: (text) => messages.push(text), warn: (text) => messages.push(text),
  info: (text) => messages.push(text), debug: (text) => messages.push(text),
  heading: (text) => messages.push(text), output: (text) => json.push(text),
};
beforeEach(async () => { root = await createRepository(); });
afterEach(async () => {
  vi.restoreAllMocks(); messages.length = 0; json.length = 0;
  await fs.rm(root, { recursive: true, force: true });
});

describe('developer question command', () => {
  it('explains why an empty card store has no questions', async () => {
    await runAskCommand({ cwd: root, json: false, logger });
    expect(messages.join('\n')).toContain('Run `docgen bootstrap` first');
  });

  it('renders owners, numbered choices, free-text questions, and a bounded preview', async () => {
    await saveCards(root, [homeCard()]);
    await runAskCommand({ cwd: root, json: false, logger });
    expect(messages.join('\n')).toContain('last touched by: dev@example.com');
    expect(messages.join('\n')).toContain('1. Everyone');
    expect(messages.join('\n')).toContain('What happens without data?');
    messages.length = 0;
    await runAskCommand({ cwd: root, limit: 1, json: false, logger });
    expect(messages.join('\n')).toContain('1 more');
    expect(messages.filter((text) => text.includes('id:'))).toHaveLength(1);
  });

  it('matches a surface title case-insensitively and omits questions owned by another developer', async () => {
    const card = homeCard();
    await saveCards(root, [{ ...card, title: 'Landing page' }]);
    await runAskCommand({ cwd: root, configFile: 'docgen.config.json', surface: 'LANDING', mine: true, json: true, logger });
    expect(JSON.parse(json.join(''))).toMatchObject({ total: 2, shown: 2, filteredBy: { mine: 'dev@example.com', surface: 'LANDING' } });
    json.length = 0;
    vi.spyOn(owners, 'currentGitEmail').mockResolvedValue('other@example.com');
    await runAskCommand({ cwd: root, mine: true, json: true, logger });
    expect(JSON.parse(json.join(''))).toMatchObject({ total: 2, shown: 0, questions: [] });
  });

  it('explains a filter that matches nothing', async () => {
    await saveCards(root, [homeCard()]);
    await runAskCommand({ cwd: root, surface: 'missing', json: false, logger });
    expect(messages.join('\n')).toContain('None match that filter.');
  });

  it('falls back to all questions when Git identity and authorship are unavailable', async () => {
    await saveCards(root, [homeCard()]);
    vi.spyOn(owners, 'currentGitEmail').mockResolvedValue(undefined);
    vi.spyOn(owners, 'lastAuthorOf').mockResolvedValue(undefined);
    await runAskCommand({ cwd: root, mine: true, json: false, logger });
    expect(messages.join('\n')).toContain('Showing all questions.');
    expect(messages.join('\n')).toContain('Open questions (2 of 2)');
    expect(messages.join('\n')).not.toContain('last touched by:');
    messages.length = 0;
    await runAskCommand({ cwd: root, json: true, logger });
    expect(JSON.parse(json.join('')).questions).toEqual([
      expect.objectContaining({ likelyOwner: null }), expect.objectContaining({ likelyOwner: null }),
    ]);
  });

  it('skips authorship lookup for fully answered cards and does not reopen their questions', async () => {
    const card = homeCard();
    await saveCards(root, [card]);
    for (const unknown of card.body.unknowns) {
      await recordAnswer({ root, surfaceId: card.surfaceId, slug: card.slug, answer: {
        questionId: unknown.id, question: unknown.question, answer: 'Confirmed behavior',
        answeredBy: 'dev@example.com', answeredAt: '2026-09-30T00:00:00.000Z',
      } });
    }
    const author = vi.spyOn(owners, 'lastAuthorOf');
    await runAskCommand({ cwd: root, json: false, logger });
    expect(messages.join('\n')).toContain('Nothing is waiting on an answer.');
    expect(author).not.toHaveBeenCalled();
  });
});
