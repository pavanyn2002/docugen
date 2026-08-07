import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Resolve the target repo's HEAD commit for provenance front matter.
 *
 * Returns undefined when the directory is not a git checkout or git is not
 * installed. That is a normal condition (SPEC rule 6: absent input is silent),
 * so the front-matter field is simply omitted rather than guessed.
 */
export async function resolveSourceCommit(root: string): Promise<string | undefined> {
  return (await resolveCommitInfo(root))?.sha;
}

export interface CommitInfo {
  readonly sha: string;
  /** ISO-8601 committer date. */
  readonly committedAt: string;
}

/**
 * HEAD's sha and commit date.
 *
 * The commit date, not the wall clock, is what dates the documentation. A
 * run-time stamp would change on every invocation, producing a diff in README
 * even when nothing about the repository moved — noise in review now, and a
 * permanently failing drift gate later.
 */
export async function resolveCommitInfo(root: string): Promise<CommitInfo | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['show', '-s', '--format=%H%n%cI', 'HEAD'], {
      cwd: root,
      timeout: 5_000,
      windowsHide: true,
    });
    const [sha, committedAt] = stdout.trim().split(/\r?\n/);
    if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) return undefined;
    if (committedAt === undefined || committedAt.length === 0) return undefined;
    return { sha, committedAt };
  } catch {
    return undefined;
  }
}
