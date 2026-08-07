import { describeUnknownError } from '../util/errors.js';
import type { AgentBackend, AgentOutcome, AgentRequest } from './types.js';

/**
 * Direct Anthropic API backend, for CI where no interactive CLI is signed in.
 *
 * `@anthropic-ai/sdk` is an optional dependency, imported only when this
 * backend actually runs. Most teams use a coding CLI they have already
 * authenticated, and forcing an SDK install on all of them to support the
 * minority case is the wrong trade.
 */

const DEFAULT_MODEL = 'claude-opus-5';

/** Generous: a feature card over a large surface is a long generation. */
const MAX_TOKENS = 16_000;

interface AnthropicMessage {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly stop_reason?: string | null;
}

interface AnthropicClientLike {
  readonly messages: {
    create(body: unknown): Promise<AnthropicMessage>;
  };
}

/**
 * Import the SDK without a compile-time dependency on it.
 *
 * The specifier is built at runtime so TypeScript does not try to resolve types
 * for a package most installs will not have. `@anthropic-ai/sdk` is optional by
 * design — see the note above.
 */
async function importAnthropicSdk(): Promise<{ default: new () => AnthropicClientLike }> {
  const specifier = ['@anthropic-ai', 'sdk'].join('/');
  return (await import(/* @vite-ignore */ specifier)) as unknown as {
    default: new () => AnthropicClientLike;
  };
}

export function createApiBackend(): AgentBackend {
  return {
    id: 'api',
    name: 'Anthropic API',
    setupHint:
      'Install @anthropic-ai/sdk in the target repo and set ANTHROPIC_API_KEY ' +
      '(or sign in with `ant auth login`).',

    async isAvailable(): Promise<boolean> {
      // The SDK resolves an API key, an auth token, or a signed-in profile, so
      // an unset ANTHROPIC_API_KEY does not mean there are no credentials.
      // Availability here means "the SDK is installed"; a missing credential
      // surfaces as a clear error on first use.
      try {
        await importAnthropicSdk();
        return true;
      } catch {
        return false;
      }
    },

    async run(request: AgentRequest): Promise<AgentOutcome> {
      let client: AnthropicClientLike;
      try {
        const module = await importAnthropicSdk();
        client = new module.default();
      } catch (error) {
        return {
          ok: false,
          reason: `Could not load @anthropic-ai/sdk: ${describeUnknownError(error)}`,
        };
      }

      const timeout = new Promise<AgentOutcome>((resolve) => {
        setTimeout(
          () => resolve({ ok: false, reason: `Anthropic API timed out after ${request.timeoutMs}ms` }),
          request.timeoutMs,
        ).unref?.();
      });

      const call = (async (): Promise<AgentOutcome> => {
        try {
          const message = await client.messages.create({
            model: request.model ?? DEFAULT_MODEL,
            max_tokens: MAX_TOKENS,
            // Adaptive thinking: the model decides how much reasoning a given
            // surface needs, which varies enormously across a codebase.
            thinking: { type: 'adaptive' },
            messages: [{ role: 'user', content: request.prompt }],
          });

          // A refusal is a successful HTTP response with no usable content.
          // Reading content[0] unconditionally would crash here.
          if (message.stop_reason === 'refusal') {
            return { ok: false, reason: 'The model declined to answer for this surface.' };
          }

          const text = message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('')
            .trim();

          return text.length === 0
            ? { ok: false, reason: 'The API returned no text content.' }
            : { ok: true, text };
        } catch (error) {
          return { ok: false, reason: `Anthropic API error: ${describeUnknownError(error)}` };
        }
      })();

      return Promise.race([call, timeout]);
    },
  };
}
