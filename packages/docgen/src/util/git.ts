import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DocgenError } from './errors.js';
import { compareStrings } from './sort.js';
import { toPosix } from './paths.js';
import picomatch from 'picomatch';

const execFileAsync = promisify(execFile);

/** Canonical empty tree, used as the comparison base for a repository's first push. */
export const EMPTY_GIT_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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

export type GitHeadFailureKind =
  | 'not-repository'
  | 'no-commits'
  | 'git-unavailable'
  | 'timeout'
  | 'dubious-ownership'
  | 'permission-denied'
  | 'invalid-head'
  | 'unknown';

export type GitHeadDiagnostic =
  | { readonly ok: true; readonly commit: CommitInfo }
  | {
      readonly ok: false;
      readonly kind: GitHeadFailureKind;
      readonly message: string;
      readonly remedy: string;
    };

export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface GitFileChange {
  readonly status: GitChangeStatus;
  readonly file: string;
  readonly previousFile?: string;
}

export interface GitChangeSet {
  readonly base: string;
  readonly changes: readonly GitFileChange[];
}

export interface FileCommitHistory {
  readonly introduced: CommitInfo;
  readonly lastChanged: CommitInfo;
}

/** Remove changes wholly outside the configured documentation boundary. */
export function filterGitChanges(
  changeSet: GitChangeSet,
  exclude: readonly string[],
): GitChangeSet {
  if (exclude.length === 0) return changeSet;
  const ignored = picomatch([...exclude], { dot: true });
  return {
    ...changeSet,
    changes: changeSet.changes.filter(
      (change) => !ignored(change.file) || (change.previousFile !== undefined && !ignored(change.previousFile)),
    ),
  };
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
  const diagnostic = await resolveGitHeadDiagnostic(root);
  return diagnostic.ok ? diagnostic.commit : undefined;
}

/** Resolve HEAD without collapsing materially different Git failures. */
export async function resolveGitHeadDiagnostic(root: string): Promise<GitHeadDiagnostic> {
  try {
    const { stdout } = await execFileAsync('git', ['show', '-s', '--format=%H%n%cI', 'HEAD'], {
      cwd: root,
      timeout: 5_000,
      windowsHide: true,
    });
    const [sha, committedAt] = stdout.trim().split(/\r?\n/);
    if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha) || committedAt === undefined || committedAt.length === 0) {
      return gitHeadFailure('invalid-head');
    }
    return { ok: true, commit: { sha, committedAt } };
  } catch (error) {
    const diagnostic = classifyGitHeadError(error);
    if (!diagnostic.ok && diagnostic.kind === 'dubious-ownership') {
      return {
        ...diagnostic,
        remedy:
          `Verify the owner of '${root}' first. Only if you trust this exact checkout, run ` +
          `\`git config --global --add safe.directory "${root}"\`. Docugen will not run it or modify global Git configuration.`,
      };
    }
    return diagnostic;
  }
}

/** Exported for deterministic mocked diagnostics. */
export function classifyGitHeadError(error: unknown): GitHeadDiagnostic {
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const code = typeof record.code === 'string' ? record.code : '';
  const stderr = typeof record.stderr === 'string' ? record.stderr : '';
  const message = `${stderr}\n${error instanceof Error ? error.message : String(error)}`.toLowerCase();
  if (code === 'ENOENT') return gitHeadFailure('git-unavailable');
  if (code === 'ETIMEDOUT' || record.killed === true || message.includes('timed out')) return gitHeadFailure('timeout');
  if (message.includes('dubious ownership') || message.includes('safe.directory')) return gitHeadFailure('dubious-ownership');
  if (message.includes('not a git repository')) return gitHeadFailure('not-repository');
  if (message.includes('does not have any commits') || message.includes('unknown revision') || message.includes('bad revision') || message.includes('ambiguous argument')) return gitHeadFailure('no-commits');
  if (code === 'EACCES' || code === 'EPERM' || message.includes('permission denied') || message.includes('access is denied')) return gitHeadFailure('permission-denied');
  if (message.includes('invalid object name') || message.includes('bad object head') || message.includes('not a valid object name')) return gitHeadFailure('invalid-head');
  return gitHeadFailure('unknown');
}

function gitHeadFailure(kind: GitHeadFailureKind): GitHeadDiagnostic {
  const details: Record<GitHeadFailureKind, readonly [string, string]> = {
    'not-repository': ['The target directory is not a Git repository.', 'Run Docugen inside a Git checkout, or initialize and commit the repository if Git provenance is required.'],
    'no-commits': ['The Git repository has no readable HEAD commit.', 'Create the first commit, then rerun Docugen. Extraction can continue without commit provenance.'],
    'git-unavailable': ['The Git executable is not installed or is not on PATH.', 'Install Git and ensure the `git` command is available to this process.'],
    timeout: ['Reading Git HEAD timed out.', 'Check for a stalled Git process, slow filesystem, or repository corruption, then retry.'],
    'dubious-ownership': ['Git refused the repository because its ownership is considered unsafe.', 'Verify the repository owner first. If you trust this exact checkout, an administrator may add its exact path to Git safe.directory; Docugen will not change global Git configuration.'],
    'permission-denied': ['Git could not read the repository because access was denied.', 'Grant this process read access to the repository and its .git metadata, then retry.'],
    'invalid-head': ['Git HEAD is invalid, unreadable, or does not resolve to a valid commit.', 'Inspect `.git/HEAD` and repository integrity with Git tooling, then repair or restore the checkout.'],
    unknown: ['Git HEAD could not be read for an unclassified reason.', 'Run `git show -s --format=%H%n%cI HEAD` in the target repository and resolve the reported error.'],
  };
  const [message, remedy] = details[kind];
  return { ok: false, kind, message, remedy };
}

function validateGitRef(ref: string): void {
  if (ref.length === 0 || ref.startsWith('-') || /[\0\r\n]/.test(ref)) {
    throw new DocgenError({
      code: 'git-base-invalid',
      message: `Git base '${ref}' is not a safe revision name.`,
      remedy: "Use a commit, tag, or branch such as 'HEAD', 'main', or 'origin/main'.",
    });
  }
}

async function requireGitRevision(root: string, ref: string): Promise<void> {
  try {
    // A tree is sufficient for `git diff` and permits EMPTY_GIT_TREE on the
    // first push, while commits, branches, and tags all resolve to their tree.
    await execFileAsync('git', ['rev-parse', '--verify', `${ref}^{tree}`], {
      cwd: root,
      timeout: 5_000,
      windowsHide: true,
    });
  } catch (cause) {
    throw new DocgenError({
      code: 'git-base-unavailable',
      message: `Could not resolve Git base '${ref}' in ${root}.`,
      remedy: 'Run this command in a Git checkout and pass a revision that exists locally.',
      file: root,
      cause,
    });
  }
}

function parseNameStatus(contents: string): GitFileChange[] {
  const fields = contents.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changes: GitFileChange[] = [];
  for (let index = 0; index < fields.length; ) {
    const rawStatus = fields[index++];
    if (rawStatus === undefined) break;
    const code = rawStatus[0];
    if (code === 'R' || code === 'C') {
      const previousFile = fields[index++];
      const file = fields[index++];
      if (previousFile !== undefined && file !== undefined) {
        changes.push({
          status: code === 'R' ? 'renamed' : 'added',
          file: toPosix(file),
          ...(code === 'R' ? { previousFile: toPosix(previousFile) } : {}),
        });
      }
      continue;
    }
    const file = fields[index++];
    if (file === undefined) break;
    const status: GitChangeStatus = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
    changes.push({ status, file: toPosix(file) });
  }
  return changes;
}

/** Working tree plus committed changes since `base`, including untracked files. */
export async function resolveGitChanges(root: string, base = 'HEAD'): Promise<GitChangeSet> {
  validateGitRef(base);
  await requireGitRevision(root, base);
  const [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
    execFileAsync('git', ['diff', '--name-status', '-z', '--find-renames', base, '--'], {
      cwd: root,
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }),
    execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }),
  ]);

  const byFile = new Map<string, GitFileChange>();
  for (const change of parseNameStatus(tracked)) byFile.set(change.file, change);
  for (const file of untracked.split('\0').filter(Boolean).map(toPosix)) {
    if (!byFile.has(file)) byFile.set(file, { status: 'added', file });
  }
  return {
    base,
    changes: [...byFile.values()].sort(
      (a, b) => compareStrings(a.file, b.file) || compareStrings(a.status, b.status),
    ),
  };
}

/** First and latest commits touching a file; absent for untracked files. */
export async function resolveFileCommitHistory(
  root: string,
  file: string,
): Promise<FileCommitHistory | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--follow', '--format=%H%x09%cI', '--reverse', '--', file],
      { cwd: root, timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    const commits = stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line): CommitInfo | undefined => {
        const [sha, committedAt] = line.split('\t');
        return sha !== undefined && committedAt !== undefined && /^[0-9a-f]{40}$/.test(sha)
          ? { sha, committedAt }
          : undefined;
      })
      .filter((item): item is CommitInfo => item !== undefined);
    const introduced = commits[0];
    const lastChanged = commits.at(-1);
    return introduced === undefined || lastChanged === undefined ? undefined : { introduced, lastChanged };
  } catch {
    return undefined;
  }
}

/** Current Git identity used to attribute explicit human-owned records. */
export async function resolveGitUserEmail(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['config', 'user.email'], {
      cwd: root,
      timeout: 5_000,
      windowsHide: true,
    });
    const email = stdout.trim();
    return email.length === 0 ? undefined : email;
  } catch {
    return undefined;
  }
}
