import { describe, expect, it } from 'vitest';
import { handleMcpRequest } from '../src/mcp/server.js';

const context = { cwd: process.cwd() };

describe('MCP server protocol', () => {
  it('negotiates initialization', async () => {
    const result = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, context);
    expect(result).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } } } });
  });

  it('lists graph, governance, question, and handoff tools', async () => {
    const result = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, context);
    const names = ((result?.['result'] as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['graph_search', 'graph_explain', 'graph_path', 'change_impact', 'plans_list', 'questions_list', 'handoff_generate']));
  });

  it('marks only handoff generation as write-capable', async () => {
    const result = await handleMcpRequest({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, context);
    const listed = (result?.['result'] as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> }).tools;
    expect(listed.find((tool) => tool.name === 'graph_search')?.annotations.readOnlyHint).toBe(true);
    expect(listed.find((tool) => tool.name === 'handoff_generate')?.annotations.readOnlyHint).toBe(false);
  });

  it('does not answer notifications', async () => {
    await expect(handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, context)).resolves.toBeUndefined();
  });

  it('returns method errors for unknown request methods', async () => {
    const result = await handleMcpRequest({ jsonrpc: '2.0', id: 3, method: 'unknown' }, context);
    expect(result).toMatchObject({ error: { code: -32601 } });
  });
});
