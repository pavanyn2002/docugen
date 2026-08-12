import { describe, expect, it } from 'vitest';
import { classifyGitHeadError } from '../src/util/git.js';

function failure(error: Record<string, unknown>) {
  return classifyGitHeadError(error);
}

describe('Git HEAD diagnostics', () => {
  it.each([
    [{ code: 'ENOENT', message: 'spawn git ENOENT' }, 'git-unavailable'],
    [{ code: 'ETIMEDOUT', message: 'timed out' }, 'timeout'],
    [{ stderr: 'fatal: not a git repository' }, 'not-repository'],
    [{ stderr: 'fatal: ambiguous argument HEAD: unknown revision' }, 'no-commits'],
    [{ stderr: 'fatal: detected dubious ownership; configure safe.directory' }, 'dubious-ownership'],
    [{ code: 'EACCES', stderr: 'permission denied' }, 'permission-denied'],
    [{ stderr: 'fatal: invalid object name HEAD' }, 'invalid-head'],
  ])('classifies %j as %s', (error, expected) => {
    expect(failure(error)).toMatchObject({ ok: false, kind: expected });
  });

  it('never recommends that Docugen modify global Git configuration automatically', () => {
    const result = failure({ stderr: 'fatal: detected dubious ownership; configure safe.directory' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.remedy).toContain('Verify the repository owner');
      expect(result.remedy).toContain('will not change global Git configuration');
    }
  });
});
