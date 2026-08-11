import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runSessionAfterEditCommand,
  runSessionEndCommand,
  runSessionStartCommand,
} from '../src/commands/session.js';
import { createLogger } from '../src/util/logger.js';

const created: string[] = [];

function captureLogger() {
  const stdout: string[] = [];
  const sink = { write: (chunk: string) => (stdout.push(chunk), true) } as unknown as NodeJS.WritableStream;
  return { stdout, logger: createLogger({ level: 'silent', stdout: sink, stderr: sink }) };
}

async function makeGitRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-session-'));
  created.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'session-fixture' }), 'utf8');
  await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export function greet() { return "hello"; }\n', 'utf8');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Developer'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('common agent session lifecycle', () => {
  it('indexes, reports impact, synchronizes docs, writes a handoff, and passes the gate', async () => {
    const root = await makeGitRepo();
    const started = captureLogger();
    await runSessionStartCommand({ cwd: root, json: true, logger: started.logger });
    expect(JSON.parse(started.stdout.join(''))).toMatchObject({
      operation: 'session-start',
      activePlans: [],
      openQuestions: [],
    });

    await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export function greet(name: string) { return `hello ${name}`; }\n', 'utf8');
    const edited = captureLogger();
    await runSessionAfterEditCommand({ cwd: root, base: 'HEAD', json: true, logger: edited.logger });
    const impact = JSON.parse(edited.stdout.join('')) as { impact: { files: Array<{ change: { file: string } }> } };
    expect(impact.impact.files.map((file) => file.change.file)).toContain('src/app.ts');

    const ended = captureLogger();
    await runSessionEndCommand({ cwd: root, base: 'HEAD', json: true, logger: ended.logger });
    expect(JSON.parse(ended.stdout.join(''))).toMatchObject({ operation: 'session-end', check: { ok: true } });
    await expect(fs.stat(path.join(root, 'docs', 'handoffs', 'tester-handoff.md'))).resolves.toBeDefined();
  });
});
