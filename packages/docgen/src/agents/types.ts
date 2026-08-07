/**
 * Pluggable LLM backends.
 *
 * The default path shells out to whatever coding CLI the developer has already
 * authenticated — `claude`, `codex`, `cursor-agent`. That choice is deliberate:
 * it means docgen never handles an API key, never asks a team to provision one,
 * and inherits whatever model access the developer already has. A direct API
 * backend exists for CI, where no interactive CLI is logged in.
 */

export interface AgentRequest {
  /** The full prompt. Backends must not modify it. */
  readonly prompt: string;
  /** Repo root; CLI backends run with this as their working directory. */
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Model override, when the backend supports one. */
  readonly model?: string;
}

export type AgentOutcome =
  | { readonly ok: true; readonly text: string }
  /**
   * A failure is never turned into content. SPEC rule 5 applies to the LLM lane
   * exactly as it does to the static one: a backend that errors, times out, or
   * returns something unreadable produces an `unknown`, not a plausible guess.
   */
  | { readonly ok: false; readonly reason: string };

export interface AgentBackend {
  /** Stable id used in config and in provenance front matter. */
  readonly id: string;
  readonly name: string;
  /** How the developer authenticates it — shown when no backend is available. */
  readonly setupHint: string;
  /** Whether this backend can run here, right now. */
  isAvailable(): Promise<boolean>;
  run(request: AgentRequest): Promise<AgentOutcome>;
}

/** Ids in the order they are tried when config says `auto`. */
export const AGENT_IDS = ['claude', 'codex', 'cursor', 'api'] as const;
export type AgentId = (typeof AGENT_IDS)[number];
