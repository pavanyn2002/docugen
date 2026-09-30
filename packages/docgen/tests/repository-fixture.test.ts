import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepository } from './helpers/repository.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('isolated Git test repositories', () => {
  it('creates a usable commit despite mandatory global signing and a rejecting global hook', async () => {
    const settings = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-git-settings-'));
    roots.push(settings);
    const hooks = path.join(settings, 'hooks');
    await fs.mkdir(hooks);
    await fs.writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const config = path.join(settings, 'global.gitconfig');
    await fs.writeFile(config, `[commit]\n  gpgsign = true\n[gpg]\n  program = docgen-test-no-signing-program\n[core]\n  hooksPath = "${hooks.replace(/\\/g, '/')}"\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    const root = await createRepository();
    roots.push(root);
    expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 5_000 }).trim()).toBe('initial');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 5_000 })).toBe('');
  });

  it('removes partial fixture files when setup fails and propagates the original failure', async () => {
    const error = new Error('fixture write failed');
    const made = vi.spyOn(fs, 'mkdtemp');
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(error);
    await expect(createRepository()).rejects.toBe(error);
    const root = await made.mock.results[0]?.value as string;
    expect(root).toEqual(expect.any(String));
    await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
