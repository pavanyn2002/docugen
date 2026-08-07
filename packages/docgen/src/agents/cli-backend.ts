import { execFile } from 'node:child_process';
import path from 'node:path';
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
      return (await resolveCommand(spec.command)) !== undefined;
    },

    async run(request: AgentRequest): Promise<AgentOutcome> {
      // Resolved to a full path rather than spawned by bare name, because on
      // Windows most of these CLIs install as a `.cmd` shim that cannot be
      // spawned directly — the availability probe would say yes and the run
      // would then fail with ENOENT.
      const resolved = await resolveCommand(spec.command);
      if (resolved === undefined) {
        return { ok: false, reason: `${spec.command} is not on PATH` };
      }

      const args = [...spec.args(request)];
      const unsafe = args.find((argument) => !SAFE_ARGUMENT.test(argument));
      if (unsafe !== undefined) {
        // Shim invocation goes through cmd.exe, so an argument carrying shell
        // metacharacters would be a command-injection hole. The only
        // caller-supplied argument is the configured model name, and refusing
        // an odd one is better than trusting the escaping to be right.
        return {
          ok: false,
          reason: `Refusing to run ${spec.name}: the argument '${unsafe}' contains characters that are not safe to pass to a command line.`,
        };
      }

      const invocation = buildInvocation(resolved, args);

      return new Promise<AgentOutcome>((resolve) => {
        const child = execFile(
          invocation.command,
          invocation.args,
          {
            cwd: request.cwd,
            timeout: request.timeoutMs,
            maxBuffer: MAX_OUTPUT_BYTES,
            windowsHide: true,
            ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
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

/**
 * Characters permitted in an argument.
 *
 * Every argument docgen passes is either a fixed flag or a model name, so this
 * is deliberately narrow: no quotes, no spaces, nothing `cmd.exe` interprets.
 */
const SAFE_ARGUMENT = /^[A-Za-z0-9._:@=+/\\-]*$/;

/** Windows shims that must be run through the command interpreter. */
const SHIM_EXTENSIONS = new Set(['.cmd', '.bat']);

interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  /** True when `args` is a single pre-quoted command line. */
  readonly verbatim: boolean;
}

/**
 * How to actually spawn the resolved executable.
 *
 * A real executable is spawned directly. A `.cmd`/`.bat` shim cannot be, so it
 * goes through `cmd.exe /d /s /c` with a command line built here. Every token
 * has already been checked against SAFE_ARGUMENT, so quoting each one is
 * sufficient — there is nothing left for the interpreter to expand.
 */
export function buildInvocation(executable: string, args: readonly string[]): Invocation {
  if (!SHIM_EXTENSIONS.has(path.extname(executable).toLowerCase())) {
    return { command: executable, args, verbatim: false };
  }

  const line = [executable, ...args].map((token) => `"${token}"`).join(' ');
  return {
    command: process.env['COMSPEC'] ?? 'cmd.exe',
    // The outer quotes are what `/s` strips, so the inner quoting survives.
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  };
}

/**
 * Resolve a command to a full executable path, without running it.
 *
 * Returns undefined when it is not installed. A real executable is preferred
 * over a shim when both are on PATH, since spawning it directly avoids the
 * command interpreter entirely.
 */
export async function resolveCommand(command: string): Promise<string | undefined> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(probe, [command], { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
      if (error !== null) {
        resolve(undefined);
        return;
      }
      resolve(pickExecutable(stdout));
    });
  });
}

/**
 * First directly-spawnable path among the probe's output lines.
 *
 * `where` on Windows commonly lists both an extensionless shell script (for Git
 * Bash, which Node cannot spawn) and a `.cmd` shim. Only `.exe` is directly
 * spawnable there, so an extensionless candidate is skipped rather than
 * preferred — picking it is how this fails with ENOENT after reporting the
 * backend as available.
 */
export function pickExecutable(output: string, platform: string = process.platform): string | undefined {
  const candidates = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (platform !== 'win32') return candidates[0];

  const runnable = candidates.filter((candidate) => path.extname(candidate).length > 0);
  return runnable.find((candidate) => path.extname(candidate).toLowerCase() === '.exe') ?? runnable[0];
}
