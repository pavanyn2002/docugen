import { describe, expect, it, vi } from 'vitest';
vi.mock('@anthropic-ai/sdk', () => { throw new Error('SDK package is not installed'); });
import { createApiBackend } from '../src/agents/api.js';

describe('optional API SDK availability', () => {
  it('allows a missing SDK to be diagnosed without crashing the caller', async () => {
    const backend = createApiBackend();
    expect(await backend.isAvailable()).toBe(false);
    expect(await backend.run({ cwd: '.', prompt: 'Documentation', timeoutMs: 100 })).toMatchObject({ ok: false, reason: expect.stringContaining('Could not load @anthropic-ai/sdk') });
  });
});
