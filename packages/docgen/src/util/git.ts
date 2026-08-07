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
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      timeout: 5_000,
      windowsHide: true,
    });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}
