import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const processBoundary = vi.hoisted(() => ({ execFile: vi.fn() }));
const sdk = vi.hoisted(() => ({ create: vi.fn(), construct: vi.fn(), loadError: false }));
vi.mock('node:child_process', () => ({ execFile: processBoundary.execFile }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class {
  constructor() { sdk.construct(); }
  messages = { create: sdk.create };
} }));

import { createCliBackend, resolveCommand, buildInvocation, pickExecutable } from '../src/agents/cli-backend.js';
import { createApiBackend } from '../src/agents/api.js';
import { getBackends, getBackend, probeBackends, resolveBackend } from '../src/agents/registry.js';
import type { AgentId, AgentRequest } from '../src/agents/types.js';

const request: AgentRequest = { cwd: 'fixture-repo', prompt: 'Document this source.', timeoutMs: 100 };
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function mockProcess(options: { path?: string; probeError?: Error; output?: string; stderr?: string; error?: Error; stdin?: boolean } = {}) {
  const stdin = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
  stdin.end = vi.fn(() => stdin.emit('error', new Error('pipe closed')));
  processBoundary.execFile.mockImplementation((command, _args, _options, callback) => {
    if (command === 'where' || command === 'which') callback(options.probeError ?? null, options.path ?? 'tool.exe', '');
    else callback(options.error ?? null, options.output ?? '  Model output  ', options.stderr ?? '');
    return { stdin: options.stdin === false ? null : stdin };
  });
  return stdin;
}

describe('CLI inference process boundary', () => {
  const backend = () => createCliBackend({ id: 'fixture', name: 'Fixture CLI', command: 'tool', setupHint: 'Install it.', args: () => ['--model', 'safe-model'] });
  it('resolves a directly executable binary and streams prompts through stdin', async () => {
    const stdin = mockProcess();
    expect(await backend().isAvailable()).toBe(true);
    expect(await backend().run(request)).toEqual({ ok: true, text: 'Model output' });
    expect(stdin.end).toHaveBeenCalledWith(request.prompt);
    expect(processBoundary.execFile).toHaveBeenLastCalledWith('tool.exe', ['--model', 'safe-model'], expect.objectContaining({ cwd: request.cwd, timeout: 100, windowsHide: true }), expect.any(Function));
  });
  it('uses the Unix command lookup boundary', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
    try { mockProcess({ path: '/usr/bin/tool' }); expect(await resolveCommand('tool')).toBe('/usr/bin/tool'); }
    finally { Object.defineProperty(process, 'platform', descriptor); }
    expect(processBoundary.execFile).toHaveBeenCalledWith('which', ['tool'], expect.any(Object), expect.any(Function));
  });
  it('reports missing executables before spawning inference', async () => {
    mockProcess({ probeError: new Error('not found') });
    expect(await backend().isAvailable()).toBe(false);
    expect(await backend().run(request)).toEqual({ ok: false, reason: 'tool is not on PATH' });
  });
  it('rejects shell metacharacters from model arguments', async () => {
    mockProcess();
    const unsafe = createCliBackend({ id: 'unsafe', name: 'Unsafe', command: 'tool', setupHint: '', args: () => ['model&delete'] });
    expect(await unsafe.run(request)).toMatchObject({ ok: false, reason: expect.stringContaining('not safe') });
    expect(processBoundary.execFile).toHaveBeenCalledTimes(1);
  });
  it.each([
    { output: '', expected: 'returned no output' },
    { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), expected: 'timed out after 100ms' },
    { error: new Error('Exit failed'), stderr: '', expected: 'failed: Exit failed' },
    { error: new Error('Exit failed'), stderr: ' Error details ', expected: 'Error details' },
  ])('reports CLI failure $expected', async ({ expected, ...options }) => {
    mockProcess(options);
    expect(await backend().run(request)).toMatchObject({ ok: false, reason: expect.stringContaining(expected) });
  });
  it('runs Windows shims verbatim and supports a process without stdin', async () => {
    mockProcess({ path: 'tool.cmd', stdin: false, output: '{"text":"Card"}' });
    const parsed = createCliBackend({ id: 'parsed', name: 'Parsed', command: 'tool', setupHint: '', args: () => [], parseOutput: (text) => (JSON.parse(text) as { text: string }).text });
    expect(await parsed.run(request)).toEqual({ ok: true, text: 'Card' });
    expect(processBoundary.execFile).toHaveBeenLastCalledWith(expect.any(String), ['/d', '/s', '/c', '""tool.cmd""'], expect.objectContaining({ windowsVerbatimArguments: true }), expect.any(Function));
  });
  it('selects shell invocation defaults and executable candidates deterministically', () => {
    vi.stubEnv('COMSPEC', undefined);
    expect(buildInvocation('tool.bat', ['-p']).command).toBe('cmd.exe');
    vi.stubEnv('COMSPEC', 'custom-shell.exe');
    expect(buildInvocation('tool.cmd', []).command).toBe('custom-shell.exe');
    expect(buildInvocation('tool.exe', ['-p'])).toEqual({ command: 'tool.exe', args: ['-p'], verbatim: false });
    expect(pickExecutable(' tool\n tool.cmd\n TOOL.EXE\n', 'win32')).toBe('TOOL.EXE');
    expect(pickExecutable('tool\n', 'win32')).toBeUndefined();
    expect(pickExecutable('tool.cmd\n', 'win32')).toBe('tool.cmd');
    expect(pickExecutable('\n', 'linux')).toBeUndefined();
    expect(pickExecutable('/usr/bin/tool\n', 'linux')).toBe('/usr/bin/tool');
  });
});

describe('API inference service boundary', () => {
  it('recognizes the SDK and sends bounded inference requests', async () => {
    sdk.create.mockResolvedValue({ content: [{ type: 'thinking' }, { type: 'text', text: ' Card ' }, { type: 'text' }] });
    const backend = createApiBackend();
    expect(await backend.isAvailable()).toBe(true);
    expect(await backend.run(request)).toEqual({ ok: true, text: 'Card' });
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-5', max_tokens: 16000, messages: [{ role: 'user', content: request.prompt }] }));
    await backend.run({ ...request, model: 'explicit-model' });
    expect(sdk.create).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'explicit-model' }));
  });
  it.each([
    { response: { stop_reason: 'refusal', content: [] }, expected: 'declined to answer' },
    { response: { content: [] }, expected: 'returned no text' },
    { response: { content: [{ type: 'text', text: ' ' }] }, expected: 'returned no text' },
  ])('reports unusable model responses', async ({ response, expected }) => {
    sdk.create.mockResolvedValue(response);
    expect(await createApiBackend().run(request)).toMatchObject({ ok: false, reason: expect.stringContaining(expected) });
  });
  it('surfaces SDK construction and HTTP errors', async () => {
    sdk.construct.mockImplementationOnce(() => { throw new Error('credential setup failed'); });
    expect(await createApiBackend().run(request)).toMatchObject({ ok: false, reason: expect.stringContaining('Could not load') });
    sdk.create.mockRejectedValueOnce(new Error('HTTP unavailable'));
    expect(await createApiBackend().run(request)).toEqual({ ok: false, reason: 'Anthropic API error: HTTP unavailable' });
  });
  it('times out when the model service never responds', async () => {
    vi.useFakeTimers();
    sdk.create.mockReturnValue(new Promise(() => {}));
    const result = createApiBackend().run(request);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ ok: false, reason: 'Anthropic API timed out after 100ms' });
  });
});

describe('backend policy selection', () => {
  it('probes all supported backends and rejects unknown ids', async () => {
    mockProcess();
    expect((await probeBackends()).map((item) => item.available)).toEqual([true, true, true, true]);
    expect(() => getBackend('missing' as AgentId)).toThrow("Unknown agent backend 'missing'");
  });
  it.each(['claude', 'codex', 'cursor'] as const)('passes optional model arguments to %s', async (id) => {
    mockProcess();
    const backend = getBackend(id);
    expect(await resolveBackend(id)).toBe(backend);
    await backend.run(request);
    await backend.run({ ...request, model: 'model-id' });
    expect(processBoundary.execFile.mock.calls.some((call) => (call[1] as string[]).includes('model-id'))).toBe(true);
  });
  it('selects the first available permitted provider', async () => {
    mockProcess();
    expect((await resolveBackend('auto', ['codex', 'cursor'])).id).toBe('codex');
    mockProcess({ probeError: new Error('not installed') });
    expect((await resolveBackend('auto')).id).toBe('api');
    expect(getBackends()).toHaveLength(4);
  });
  it('reports unavailable explicit providers and fully blocked policies', async () => {
    mockProcess({ probeError: new Error('not installed') });
    await expect(resolveBackend('claude')).rejects.toThrow('not available');
    await expect(resolveBackend('claude', ['codex'])).rejects.toThrow('not allowed');
    await expect(resolveBackend('claude', [])).rejects.toMatchObject({ remedy: expect.stringContaining('local-only policy blocks inference') });
    await expect(resolveBackend('auto', ['claude'])).rejects.toMatchObject({ remedy: expect.stringContaining('Claude Code') });
    await expect(resolveBackend('auto', [])).rejects.toThrow('No LLM backend');
  });
});
