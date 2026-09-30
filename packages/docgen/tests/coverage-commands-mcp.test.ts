import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import readline from 'node:readline';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleMcpRequest, runMcpServer } from '../src/mcp/server.js';
import { createRepository } from './helpers/repository.js';

afterEach(() => vi.restoreAllMocks());

describe('MCP stdio stream contract', () => {
  it('serializes ordered requests, ignores notifications, and recovers from malformed input', async () => {
    const stream = new EventEmitter();
    vi.spyOn(readline, 'createInterface').mockReturnValue(stream as readline.Interface);
    const output: string[] = [];
    const errors: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { errors.push(String(chunk)); return true; });
    const running = runMcpServer({ cwd: '.' });
    for (const line of ['broken json', 'null', '{"jsonrpc":"2.0","method":"notification"}', '{"jsonrpc":"2.0","id":1,"method":"ping"}', '{"jsonrpc":"2.0","id":null,"method":"unknown"}']) stream.emit('line', line);
    stream.emit('close');
    await running;
    expect(output.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found: unknown' } },
    ]);
    expect(errors.join('')).toContain('docgen mcp:');
  });

  it.each(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])('preserves a supported client protocol %s', async (protocolVersion) => {
    expect(await handleMcpRequest({ jsonrpc: '2.0', id: null, method: 'initialize', params: { protocolVersion } }, { cwd: '.' }))
      .toMatchObject({ result: { protocolVersion } });
  });

  it('returns an actionable unsupported method error', async () => {
    expect(await handleMcpRequest({ jsonrpc: '2.0', id: null, method: 'unknown' }, { cwd: '.' }))
      .toMatchObject({ id: null, error: { code: -32601, message: 'Method not found: unknown' } });
  });

  it('validates optional string and numeric arguments before invoking a tool', async () => {
    const root = await createRepository();
    try {
      for (const argumentsValue of [{ text: 'home', kinds: '' }, { text: 'home', limit: NaN }, { text: 'home', limit: Infinity }, { text: 'home', limit: null }]) {
        const result = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'graph_search', arguments: argumentsValue } }, { cwd: root });
        expect(result?.result).toMatchObject({ isError: true });
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('returns empty structured content when no cards exist yet', async () => {
    const root = await createRepository();
    try {
      const response = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'questions_list' } }, { cwd: root });
      expect(response?.result).toMatchObject({ structuredContent: {}, content: [{ type: 'text', text: 'null' }] });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
