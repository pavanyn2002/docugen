import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BLOCK_END, BLOCK_START, upsertManagedBlock } from '../src/adapters/block.js';
import { installAdapters } from '../src/adapters/install.js';
import { renderAgentInstructions, renderCursorRule } from '../src/adapters/instructions.js';
import { resolveInvocation } from '../src/commands/init.js';

const created: string[] = [];

async function makeRepo(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-adapters-'));
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

describe('managed block', () => {
  it('appends to an empty file', () => {
    const result = upsertManagedBlock('', 'hello');
    expect(result.action).toBe('created');
    expect(result.contents).toContain(BLOCK_START);
    expect(result.contents).toContain('hello');
  });

  it('keeps the team content above its own block', () => {
    const existing = '# Our rules\n\nAlways run the linter.\n';
    const result = upsertManagedBlock(existing, 'docgen says hi');

    expect(result.contents.indexOf('Always run the linter.')).toBeLessThan(
      result.contents.indexOf(BLOCK_START),
    );
  });

  it('replaces only what is between the markers', () => {
    const first = upsertManagedBlock('# Ours\n\nKeep me.\n', 'version one').contents;
    const second = upsertManagedBlock(first, 'version two');

    expect(second.action).toBe('updated');
    expect(second.contents).toContain('Keep me.');
    expect(second.contents).toContain('version two');
    expect(second.contents).not.toContain('version one');
  });

  it('preserves content written after the block', () => {
    const withBlock = upsertManagedBlock('# Ours\n', 'body').contents;
    const withTrailer = `${withBlock}\n## Added later\n\nStill here.\n`;
    const updated = upsertManagedBlock(withTrailer, 'new body');

    expect(updated.contents).toContain('Still here.');
    expect(updated.contents).toContain('## Added later');
  });

  it('reports unchanged when the body is identical, so nothing is rewritten', () => {
    const first = upsertManagedBlock('# Ours\n', 'same').contents;
    expect(upsertManagedBlock(first, 'same').action).toBe('unchanged');
  });

  it('appends rather than guessing when the markers are out of order', () => {
    // A mangled file must not have "everything between the markers" replaced —
    // that would delete the team's content sitting between them.
    const mangled = `${BLOCK_END}\nImportant team content.\n${BLOCK_START}\n`;
    const result = upsertManagedBlock(mangled, 'body');

    expect(result.action).toBe('created');
    expect(result.contents).toContain('Important team content.');
  });

  it('warns that edits inside the block are lost', () => {
    expect(upsertManagedBlock('', 'body').contents).toContain('Edits between these markers are overwritten');
  });
});

describe('agent instructions', () => {
  it('tells the agent never to answer on the developer behalf', () => {
    const text = renderAgentInstructions({ invocation: 'docgen' });
    expect(text).toContain('Never answer these questions yourself');
  });

  it('warns that bootstrap costs money', () => {
    const text = renderAgentInstructions({ invocation: 'docgen' });
    expect(text).toContain('costs money');
  });

  it('uses the repo’s own invocation in every command it shows', () => {
    const text = renderAgentInstructions({ invocation: 'npx docgen' });
    expect(text).toContain('npx docgen ask --mine');
    expect(text).toContain('npx docgen answer');
    expect(text).not.toContain('`docgen ask');
  });

  it('gives the cursor rule the front matter that makes it apply', () => {
    const rule = renderCursorRule({ invocation: 'docgen' });
    expect(rule.startsWith('---\n')).toBe(true);
    expect(rule).toContain('alwaysApply: true');
  });
});

describe('installing adapters', () => {
  it('always writes AGENTS.md, the one file every agent reads', async () => {
    const root = await makeRepo();
    const outcomes = await installAdapters({ root, invocation: 'docgen' });

    expect(outcomes.map((outcome) => outcome.file)).toEqual(['AGENTS.md']);
    expect(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8')).toContain('docgen ask --mine');
  });

  it('does not create tool directories a repo has never used', async () => {
    const root = await makeRepo();
    await installAdapters({ root, invocation: 'docgen' });

    await expect(fs.stat(path.join(root, '.cursor'))).rejects.toThrow();
    await expect(fs.stat(path.join(root, 'CLAUDE.md'))).rejects.toThrow();
  });

  it('adds a cursor rule when the repo already uses Cursor', async () => {
    const root = await makeRepo({ '.cursor/rules/team.mdc': '---\n---\n' });
    const outcomes = await installAdapters({ root, invocation: 'docgen' });

    expect(outcomes.map((outcome) => outcome.file)).toContain('.cursor/rules/docgen.mdc');
  });

  it('adds to an existing CLAUDE.md without disturbing it', async () => {
    const root = await makeRepo({ 'CLAUDE.md': '# House rules\n\nUse tabs.\n' });
    await installAdapters({ root, invocation: 'docgen' });

    const contents = await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(contents).toContain('Use tabs.');
    expect(contents).toContain('docgen ask --mine');
  });

  it('installs everything when asked, regardless of evidence', async () => {
    const root = await makeRepo();
    const outcomes = await installAdapters({ root, invocation: 'docgen', all: true });

    expect(outcomes.map((outcome) => outcome.file).sort()).toEqual([
      '.cursor/rules/docgen.mdc',
      '.github/workflows/docgen.yml',
      'AGENTS.md',
      'CLAUDE.md',
    ]);
  });

  it('adds an update policy only where docgen is a pinned dependency', async () => {
    const local = await makeRepo({ '.github/workflows/test.yml': 'name: test\n' });
    const outcomes = await installAdapters({ root: local, invocation: 'npx docgen' });
    expect(outcomes.map((outcome) => outcome.file)).toContain('.github/dependabot.yml');

    // Installed globally, so there is no dependency for dependabot to bump.
    const globalInstall = await makeRepo({ '.github/workflows/test.yml': 'name: test\n' });
    const none = await installAdapters({ root: globalInstall, invocation: 'docgen' });
    expect(none.map((outcome) => outcome.file)).not.toContain('.github/dependabot.yml');
  });

  it('never overwrites an existing update policy', async () => {
    const existing = 'version: 2\nupdates:\n  - package-ecosystem: docker\n';
    const root = await makeRepo({
      '.github/workflows/test.yml': 'name: test\n',
      '.github/dependabot.yml': existing,
    });

    await installAdapters({ root, invocation: 'npx docgen' });

    expect(await fs.readFile(path.join(root, '.github/dependabot.yml'), 'utf8')).toBe(existing);
  });

  it('adds the CI gate only where GitHub Actions is already in use', async () => {
    const withActions = await makeRepo({ '.github/workflows/test.yml': 'name: test\n' });
    const outcomes = await installAdapters({ root: withActions, invocation: 'docgen' });
    expect(outcomes.map((outcome) => outcome.file)).toContain('.github/workflows/docgen.yml');

    const without = await makeRepo();
    const none = await installAdapters({ root: without, invocation: 'docgen' });
    expect(none.map((outcome) => outcome.file)).not.toContain('.github/workflows/docgen.yml');
  });

  it('targets the branch the repo actually uses', async () => {
    const root = await makeRepo({ '.github/workflows/test.yml': 'name: test\n' });
    await installAdapters({ root, invocation: 'npx docgen', defaultBranch: 'develop' });

    const workflow = await fs.readFile(path.join(root, '.github/workflows/docgen.yml'), 'utf8');
    expect(workflow).toContain('branches: [develop]');
    expect(workflow).toContain('npx docgen check');
  });

  it('fetches and pins docgen in CI when it is not a repo dependency', async () => {
    // Otherwise the workflow runs `npm ci` in a repo that may have no manifest,
    // then calls a `docgen` the runner never installed.
    const root = await makeRepo({ '.github/workflows/test.yml': 'name: test\n' });
    await installAdapters({ root, invocation: 'docgen', version: '1.2.3' });

    const workflow = await fs.readFile(path.join(root, '.github/workflows/docgen.yml'), 'utf8');
    expect(workflow).toContain('npx --yes @tatvaops/docgen@1.2.3 check');
    expect(workflow).not.toContain('npm ci');
  });

  it('is idempotent', async () => {
    const root = await makeRepo();
    await installAdapters({ root, invocation: 'docgen' });
    const before = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');

    const second = await installAdapters({ root, invocation: 'docgen' });

    expect(second.every((outcome) => outcome.action === 'unchanged')).toBe(true);
    expect(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe(before);
  });

  it('writes LF endings', async () => {
    const root = await makeRepo();
    await installAdapters({ root, invocation: 'docgen' });
    expect(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8')).not.toContain('\r\n');
  });
});

describe('invocation detection', () => {
  it('uses npx when docgen is a dependency of the repo', async () => {
    const root = await makeRepo({
      'package.json': JSON.stringify({ devDependencies: { '@tatvaops/docgen': '^0.1.0' } }),
    });
    await expect(resolveInvocation(root)).resolves.toBe('npx docgen');
  });

  it('falls back to the bare command when it is installed globally', async () => {
    const root = await makeRepo({ 'package.json': JSON.stringify({ name: 'app' }) });
    await expect(resolveInvocation(root)).resolves.toBe('docgen');
  });

  it('does not fail on a repo with no package.json', async () => {
    const root = await makeRepo();
    await expect(resolveInvocation(root)).resolves.toBe('docgen');
  });

  it('does not fail on a malformed package.json', async () => {
    const root = await makeRepo({ 'package.json': '{ not json' });
    await expect(resolveInvocation(root)).resolves.toBe('docgen');
  });
});
