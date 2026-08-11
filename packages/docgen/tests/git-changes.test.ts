import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_GIT_TREE, filterGitChanges, resolveFileCommitHistory, resolveGitChanges } from '../src/util/git.js';

describe('Git change discovery', () => {
  it('filters generated files but preserves renames crossing the boundary', () => {
    expect(
      filterGitChanges(
        {
          base: 'HEAD',
          changes: [
            { status: 'added', file: 'docs/handoffs/tester-handoff.md' },
            { status: 'modified', file: 'src/app.ts' },
            { status: 'renamed', file: 'docs/handoffs/old.ts', previousFile: 'src/old.ts' },
          ],
        },
        ['**/docs/handoffs/**'],
      ).changes,
    ).toEqual([
      { status: 'modified', file: 'src/app.ts' },
      { status: 'renamed', file: 'docs/handoffs/old.ts', previousFile: 'src/old.ts' },
    ]);
  });

  it('finds tracked, untracked, and renamed files with commit history', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-git-impact-'));
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true });
    };
    try {
      try {
        git('init', '-q');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'Docgen Test');
        git('config', 'core.autocrlf', 'false');
      } catch {
        return;
      }
      await fs.writeFile(path.join(root, 'old.ts'), 'export const value = 1;\n');
      await fs.writeFile(path.join(root, 'same.ts'), 'before\n');
      git('add', '.');
      git('commit', '-q', '-m', 'initial');
      await fs.writeFile(path.join(root, 'same.ts'), 'committed second version\n');
      git('add', 'same.ts');
      git('commit', '-q', '-m', 'change same');

      await fs.rename(path.join(root, 'old.ts'), path.join(root, 'renamed.ts'));
      await fs.writeFile(path.join(root, 'same.ts'), 'after\n');
      await fs.writeFile(path.join(root, 'new.ts'), 'new\n');
      git('add', '-A');
      await fs.writeFile(path.join(root, 'untracked.ts'), 'not staged\n');

      await expect(resolveGitChanges(root)).resolves.toEqual({
        base: 'HEAD',
        changes: [
          { status: 'added', file: 'new.ts' },
          { status: 'renamed', file: 'renamed.ts', previousFile: 'old.ts' },
          { status: 'modified', file: 'same.ts' },
          { status: 'added', file: 'untracked.ts' },
        ],
      });
      const initial = await resolveGitChanges(root, EMPTY_GIT_TREE);
      expect(initial.changes.map((change) => change.file)).toEqual(
        expect.arrayContaining(['new.ts', 'renamed.ts', 'same.ts', 'untracked.ts']),
      );
      const history = await resolveFileCommitHistory(root, 'old.ts');
      expect(history?.introduced.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(history?.lastChanged.sha).toBe(history?.introduced.sha);
      const changedHistory = await resolveFileCommitHistory(root, 'same.ts');
      expect(changedHistory?.lastChanged.sha).not.toBe(changedHistory?.introduced.sha);
      await expect(resolveGitChanges(root, '--output=bad')).rejects.toThrow(/not a safe revision/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
