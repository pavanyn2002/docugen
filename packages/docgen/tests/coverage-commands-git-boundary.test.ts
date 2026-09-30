import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/util/logger.js';
import { execFileSync } from 'node:child_process';

const boundary = vi.hoisted(() => ({ failHead: false, blankRemoteHead: false }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await vi.importActual<typeof import('node:util')>('node:util');
  const nativeAsync = promisify(actual.execFile);
  const execFile = vi.fn(actual.execFile);
  Object.defineProperty(execFile, promisify.custom, { value: async (...args: Parameters<typeof nativeAsync>) => {
    const [command, argv] = args;
    if (command === 'git' && Array.isArray(argv)) {
      if (boundary.failHead && argv[0] === 'show' && argv[1] === '-s') throw Object.assign(new Error('Git HEAD read timed out'), { code: 'ETIMEDOUT' });
      if (boundary.blankRemoteHead && argv[0] === 'symbolic-ref') return { stdout: '', stderr: '' };
    }
    return nativeAsync(...args);
  } });
  return { ...actual, execFile };
});

import { runChangeRecordCommand } from '../src/commands/change.js';
import { runHandoffCommand } from '../src/commands/handoff.js';
import { resolveDefaultBranch } from '../src/commands/init.js';
import { loadChangeRecords } from '../src/changes/store.js';
import { createRepository, seedGovernance } from './helpers/repository.js';

let root: string;
const outputs: string[] = [];
const logger: Logger = { level: 'silent', error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), heading: vi.fn(), output: (text) => outputs.push(text) };
beforeEach(async () => { root = await createRepository(); });
afterEach(async () => { boundary.failHead = false; boundary.blankRemoteHead = false; outputs.length = 0; await fs.rm(root, { recursive: true, force: true }); });

describe('command Git subprocess degradation', () => {
  it('keeps changed-file evidence when optional HEAD metadata times out', async () => {
    await seedGovernance(root);
    await fs.writeFile(path.join(root, 'app/page.tsx'), 'export default function Home() { return "updated"; }');
    boundary.failHead = true;
    await runChangeRecordCommand({ cwd: root, id: 'head-unavailable', summary: 'Update', features: 'home', json: true, logger });
    expect((await loadChangeRecords(root))[0]).toMatchObject({ id: 'head-unavailable', files: [{ file: 'app/page.tsx', status: 'modified' }] });
    expect((await loadChangeRecords(root))[0]?.headCommit).toBeUndefined();
    await runHandoffCommand({ cwd: root, json: true, logger });
    expect(JSON.parse(outputs.pop()!).changedFiles).toBe(1);
    expect(await fs.readFile(path.join(root, 'docs/handoffs/tester-handoff.md'), 'utf8')).toContain('app/page.tsx');
  });

  it('falls back to the local branch when remote HEAD lookup returns no output', async () => {
    boundary.blankRemoteHead = true;
    expect(await resolveDefaultBranch(root)).toBe(execFileSync('git', ['branch', '--show-current'], { cwd: root, windowsHide: true }).toString().trim());
  });
});
