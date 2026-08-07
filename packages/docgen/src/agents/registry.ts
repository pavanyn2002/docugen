import { createCliBackend } from './cli-backend.js';
import { createApiBackend } from './api.js';
import { DocgenError } from '../util/errors.js';
import type { AgentBackend, AgentId } from './types.js';
import { AGENT_IDS } from './types.js';

/**
 * The backends docgen can drive, in the order `auto` tries them.
 *
 * CLI backends come first on purpose: they use credentials the developer
 * already has, so adopting docgen costs nobody an API key. The direct API
 * backend is the CI fallback.
 */

/**
 * `claude -p` prints the assistant's text to stdout and exits.
 * `--output-format text` pins that, so a future default change cannot start
 * feeding us JSON that the card parser would reject as unreadable.
 */
const claudeBackend = createCliBackend({
  id: 'claude',
  name: 'Claude Code',
  command: 'claude',
  args: (request) => [
    '-p',
    '--output-format',
    'text',
    ...(request.model === undefined ? [] : ['--model', request.model]),
  ],
  setupHint: 'Install Claude Code and run `claude` once to sign in.',
});

const codexBackend = createCliBackend({
  id: 'codex',
  name: 'Codex CLI',
  command: 'codex',
  args: (request) => [
    'exec',
    ...(request.model === undefined ? [] : ['--model', request.model]),
    '-',
  ],
  setupHint: 'Install the Codex CLI and run `codex login`.',
});

const cursorBackend = createCliBackend({
  id: 'cursor',
  name: 'Cursor Agent',
  command: 'cursor-agent',
  args: (request) => [
    '-p',
    ...(request.model === undefined ? [] : ['--model', request.model]),
  ],
  setupHint: 'Install cursor-agent and sign in to Cursor.',
});

export function getBackends(): readonly AgentBackend[] {
  return [claudeBackend, codexBackend, cursorBackend, createApiBackend()];
}

export function getBackend(id: AgentId): AgentBackend {
  const backend = getBackends().find((candidate) => candidate.id === id);
  if (backend === undefined) {
    throw new DocgenError({
      code: 'unknown-agent',
      message: `Unknown agent backend '${id}'.`,
      remedy: `Valid backends are: ${AGENT_IDS.join(', ')}, or 'auto' to pick the first available.`,
    });
  }
  return backend;
}

export interface BackendAvailability {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly setupHint: string;
}

export async function probeBackends(): Promise<readonly BackendAvailability[]> {
  const results: BackendAvailability[] = [];
  for (const backend of getBackends()) {
    results.push({
      id: backend.id,
      name: backend.name,
      available: await backend.isAvailable(),
      setupHint: backend.setupHint,
    });
  }
  return results;
}

/**
 * Resolve the backend to use.
 *
 * An explicitly configured backend that is unavailable is an error rather than
 * a silent downgrade: switching models behind someone's back changes what the
 * documentation says and what it costs.
 */
export async function resolveBackend(configured: AgentId | 'auto'): Promise<AgentBackend> {
  if (configured !== 'auto') {
    const backend = getBackend(configured);
    if (!(await backend.isAvailable())) {
      throw new DocgenError({
        code: 'agent-unavailable',
        message: `The configured agent backend '${configured}' is not available here.`,
        remedy: backend.setupHint,
      });
    }
    return backend;
  }

  for (const backend of getBackends()) {
    if (await backend.isAvailable()) return backend;
  }

  const hints = getBackends().map((backend) => `  - ${backend.name}: ${backend.setupHint}`);
  throw new DocgenError({
    code: 'no-agent-available',
    message: 'No LLM backend is available, so nothing can be inferred.',
    remedy: `Set up any one of these, then re-run:\n${hints.join('\n')}`,
  });
}
