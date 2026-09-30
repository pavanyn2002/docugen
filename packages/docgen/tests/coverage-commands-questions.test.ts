import fs from 'node:fs/promises';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnswerCommand } from '../src/commands/answer.js';
import { runTriageCommand } from '../src/commands/triage.js';
import { runStatusCommand } from '../src/commands/status.js';
import { runSyncCommand } from '../src/commands/sync.js';
import { runFleetCommand } from '../src/commands/fleet.js';
import { loadRequirements } from '../src/requirements/store.js';
import { saveCards } from '../src/infer/store.js';
import { BEHAVIOR_CONFIRMATION } from '../src/infer/verification.js';
import type { Logger } from '../src/util/logger.js';
import { createRepository, homeCard, seedGovernance } from './helpers/repository.js';
vi.mock('node:readline/promises', () => ({ createInterface: vi.fn() }));

let root: string;
const messages: string[] = [];
const outputs: string[] = [];
const logger: Logger = { level: 'debug', error: (s) => messages.push(s), warn: (s) => messages.push(s), info: (s) => messages.push(s), debug: (s) => messages.push(s), heading: (s) => messages.push(s), output: (s) => outputs.push(s) };
const options = () => ({ cwd: root, logger });
beforeEach(async () => { root = await createRepository(); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); messages.length = 0; outputs.length = 0; await fs.rm(root, { recursive: true, force: true }); });
async function answer(questionId: string, text = 'Everyone') { await runAnswerCommand({ ...options(), surface: 'home', questionId, answer: text }); }
function terminal() {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  return () => { if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor); else Reflect.deleteProperty(process.stdin, 'isTTY'); };
}

describe('human question validation and replacement', () => {
  it('replaces an existing answer, resolves surface ids, and records unconfigured authors', async () => {
    await seedGovernance(root);
    await answer('access');
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'no-global-config'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    await fs.rm(path.join(root, '.git'), { recursive: true });
    await runAnswerCommand({ ...options(), configFile: 'docgen.config.json', surface: 'screen:/', questionId: 'access', answer: 'Signed-in users', note: 'Reviewed' });
    expect(messages.join('\n')).toContain('replaced a previous answer: Everyone');
    await runTriageCommand({ ...options(), surface: 'screen:/', questionId: 'access', kind: 'decision' });
    expect([...(await loadRequirements(root)).values()].flatMap((surface) => surface.requirements)[0]?.recordedBy).toBe('unknown');
  });
  it('explains unknown surfaces with a bounded list and unknown questions with no options', async () => {
    const cards = Array.from({ length: 21 }, (_, index) => ({ ...homeCard(), surfaceId: `screen:/${index}`, slug: `surface-${index}`, body: { ...homeCard().body, unknowns: [] } }));
    await saveCards(root, cards);
    await expect(runAnswerCommand({ ...options(), surface: 'missing', questionId: 'missing', answer: 'yes' })).rejects.toMatchObject({ remedy: expect.stringContaining('surface-8, …') });
    await expect(runAnswerCommand({ ...options(), surface: 'surface-0', questionId: 'missing', answer: 'yes' })).rejects.toMatchObject({ remedy: 'This surface has no unanswered questions.' });
    await runAnswerCommand({ ...options(), surface: 'surface-0', questionId: BEHAVIOR_CONFIRMATION.id, answer: 'Confirmed' });
    expect(messages.join('\n')).toContain('Answer recorded');
  });
  it('reports pending classifications and rejects incomplete, unsupported, and already classified requests', async () => {
    await seedGovernance(root);
    await answer('access');
    await runTriageCommand({ ...options(), list: true });
    expect(messages.join('\n')).toContain('answered: Everyone');
    await runTriageCommand({ ...options(), json: true });
    expect(JSON.parse(outputs.pop()!).items[0]).toMatchObject({ questionId: 'access', answer: 'Everyone' });
    for (const extra of [{ surface: 'home' }, { surface: 'home', questionId: 'access' }, { surface: 'home', kind: 'bug' }]) await expect(runTriageCommand({ ...options(), ...extra })).rejects.toMatchObject({ code: 'triage-incomplete' });
    await expect(runTriageCommand({ ...options(), surface: 'home', questionId: 'access', kind: 'bad' })).rejects.toMatchObject({ code: 'unknown-kind' });
    await expect(runTriageCommand({ ...options(), surface: 'missing', questionId: 'access', kind: 'bug' })).rejects.toMatchObject({ code: 'nothing-to-triage' });
    await expect(runTriageCommand({ ...options(), surface: 'home', questionId: 'missing', kind: 'bug' })).rejects.toMatchObject({ code: 'nothing-to-triage' });
    await runTriageCommand({ ...options(), surface: 'home', questionId: 'access', kind: 'context', note: 'Context' });
    await runTriageCommand(options());
    expect(messages.join('\n')).toContain('Nothing to triage');
  });
});

describe('interactive triage at the terminal boundary', () => {
  it.each(['s', '', 'bad', 'q', '1', '2', '3', '4'])('handles terminal choice %j', async (choice) => {
    await seedGovernance(root);
    await answer('access');
    const question = vi.fn().mockResolvedValue(choice);
    const close = vi.fn();
    vi.mocked(readline.createInterface).mockReturnValue({ question, close } as unknown as readline.Interface);
    const restore = terminal();
    try { await runTriageCommand(options()); } finally { restore(); }
    expect(close).toHaveBeenCalledOnce();
    expect(question).toHaveBeenCalledOnce();
    expect([...(await loadRequirements(root)).values()].flatMap((surface) => surface.requirements)).toHaveLength(/^[1-4]$/.test(choice) ? 1 : 0);
    if (choice === 'bad') expect(messages.join('\n')).toContain('not one of the options');
  });
  it('closes the terminal on an interrupted prompt while preserving previous decisions', async () => {
    await seedGovernance(root);
    await answer('access'); await answer('empty', 'Show no data');
    const close = vi.fn();
    const question = vi.fn().mockResolvedValueOnce('1').mockRejectedValueOnce(new Error('Interrupted'));
    vi.mocked(readline.createInterface).mockReturnValue({ question, close } as unknown as readline.Interface);
    const restore = terminal();
    try { await expect(runTriageCommand(options())).rejects.toThrow('Interrupted'); } finally { restore(); }
    expect(close).toHaveBeenCalledOnce();
    expect([...(await loadRequirements(root)).values()].flatMap((surface) => surface.requirements)).toHaveLength(1);
  });
});

describe('status guidance and fleet failure reporting', () => {
  it('advances the next action as documentation, answers, classifications, and tests are added', async () => {
    await runSyncCommand(options());
    await runStatusCommand(options());
    expect(messages.join('\n')).toContain('docgen bootstrap');
    await saveCards(root, [homeCard()]); await runSyncCommand(options()); messages.length = 0;
    await runStatusCommand(options()); expect(messages.join('\n')).toContain('docgen ask --mine');
    await answer('access'); await answer('empty', 'Show no data'); await answer(BEHAVIOR_CONFIRMATION.id, 'Confirmed'); messages.length = 0;
    await runStatusCommand(options()); expect(messages.join('\n')).toContain('docgen triage');
    for (const questionId of ['access', 'empty', BEHAVIOR_CONFIRMATION.id]) await runTriageCommand({ ...options(), surface: 'home', questionId, kind: 'requirement' });
    messages.length = 0;
    await runStatusCommand(options()); expect(messages.join('\n')).toContain('cite the untested requirement ids');
    const requirements = [...(await loadRequirements(root)).values()].flatMap((surface) => surface.requirements);
    await fs.mkdir(path.join(root, 'tests'));
    await fs.writeFile(path.join(root, 'tests/home.test.ts'), requirements.map((item) => `// ${item.id}\n`).join(''));
    await runSyncCommand(options()); messages.length = 0;
    await runStatusCommand(options()); expect(messages.join('\n')).toContain('Nothing outstanding');
  }, 30_000);
  it('writes a recoverable fleet dashboard including unreadable repositories', async () => {
    const missing = path.join(root, 'missing');
    await runFleetCommand({ paths: [root, missing], out: path.join(root, 'fleet.md'), logger });
    expect(await fs.readFile(path.join(root, 'fleet.md'), 'utf8')).toContain('Could not be read');
    expect(messages.join('\n')).toContain('could not be read');
    await runFleetCommand({ paths: [root, missing], json: true, logger });
    expect(JSON.parse(outputs.pop()!).failures).toHaveLength(1);
  });
});
