import { execFile } from 'node:child_process';
import { describeUnknownError } from '../util/errors.js';
import type { AgentBackend, AgentOutcome, AgentRequest } from './types.js';

/**
 * A backend that shells out to a coding CLI.
 *
 * The prompt goes in on stdin rather than argv: feature-card prompts carry
 * whole source files and would blow past the command-line length limit on
 * Windows, and quoting arbitrary code into a shell argument is a defect waiting
 * to happen.
 */
export interface CliBackendSpec {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  /** Arguments for a one-shot, non-interactive run. */
  readonly args: (request: AgentRequest) => readonly string[];
  readonly setupHint: string;
  /** Extracts the model's text from the CLI's output. */
  readonly parseOutput?: (stdout: string) => string;
}

/** Output cap. A runaway CLI must not exhaust memory. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export function createCliBackend(spec: CliBackendSpec): AgentBackend {
  return {
    id: spec.id,
    name: spec.name,
    setupHint: spec.setupHint,

    async isAvailable(): Promise<boolean> {
      return commandExists(spec.command);
    },

    async run(request: AgentRequest): Promise<AgentOutcome> {
      return new Promise<AgentOutcome>((resolve) => {
        const child = execFile(
          spec.command,
          [...spec.args(request)],
          {
            cwd: request.cwd,
            timeout: request.timeoutMs,
            maxBuffer: MAX_OUTPUT_BYTES,
            windowsHide: true,
            // The CLI must not try to open an editor or pager.
            env: { ...process.env, PAGER: 'cat', EDITOR: 'true', NO_COLOR: '1' },
          },
          (error, stdout, stderr) => {
            if (error !== null) {
              const timedOut = (error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
              resolve({
                ok: false,
                reason: timedOut
                  ? `${spec.name} timed out after ${request.timeoutMs}ms`
                  : `${spec.name} failed: ${describeUnknownError(error)}${
                      stderr.trim().length > 0 ? ` — ${stderr.trim().slice(0, 300)}` : ''
                    }`,
              });
              return;
            }

            const text = (spec.parseOutput ?? ((value: string) => value))(stdout).trim();
            if (text.length === 0) {
              resolve({ ok: false, reason: `${spec.name} returned no output` });
              return;
            }
            resolve({ ok: true, text });
          },
        );

        child.stdin?.on('error', () => {
          // A CLI that closes stdin early surfaces through the exit handler.
        });
        child.stdin?.end(request.prompt);
      });
    },
  };
}

/** Whether a command resolves on PATH, without running it. */
export async function commandExists(command: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(probe, [command], { windowsHide: true, timeout: 5_000 }, (error) => {
      resolve(error === null);
    });
  });
}
