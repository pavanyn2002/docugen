import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleMcpRequest } from '../src/mcp/server.js';
import { createRepository, seedGovernance } from './helpers/repository.js';

let root: string;

beforeEach(async () => {
  root = await createRepository();
  await seedGovernance(root);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function call(name: string, args?: Record<string, unknown>, configured = false) {
  const response = await handleMcpRequest({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name, ...(args === undefined ? {} : { arguments: args }) },
  }, { cwd: root, ...(configured ? { configFile: 'docgen.config.json' } : {}) });
  expect(response).toMatchObject({ jsonrpc: '2.0', id: 7 });
  return response?.['result'] as { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
}

describe('MCP tool execution', () => {
  it('searches extracted nodes with explicit filters and default options', async () => {
    for (const args of [{ text: 'app/page.tsx' }, { text: 'app/page.tsx', kinds: 'file', limit: 1 }]) {
      const result = await call('graph_search', args, true);
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('file:app/page.tsx');
      expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
    }
  });

  it('explains the requested node and finds a path with supplied traversal limits', async () => {
    const explained = await call('graph_explain', { id: 'file:app/page.tsx' });
    expect(explained.isError).toBeUndefined();
    expect(explained.content[0]?.text).toContain('app/page.tsx');
    for (const args of [
      { from: 'file:app/page.tsx', to: 'file:app/page.tsx' },
      { from: 'file:app/page.tsx', to: 'file:app/page.tsx', direction: 'both', edgeKinds: 'imports', maxDepth: 0 },
    ]) {
      const result = await call('graph_path', args);
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ found: true });
    }
  });

  it('reports changed code with default and explicit Git comparison options', async () => {
    await fs.writeFile(path.join(root, 'app/page.tsx'), 'export default function Home() { return "Updated"; }\n');
    for (const args of [undefined, { base: 'HEAD', maxDepth: 2, limit: 1 }]) {
      const result = await call('change_impact', args);
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain('app/page.tsx');
    }
  });

  it('lists plans and reads one attributed plan', async () => {
    const listed = await call('plans_list');
    expect(listed.isError).toBeUndefined();
    expect(listed.structuredContent).toMatchObject({ count: 1, plans: [{ id: 'home-update', featureId: 'home' }] });
    const shown = await call('plan_show', { id: 'home-update' });
    expect(shown.isError).toBeUndefined();
    expect(shown.structuredContent).toMatchObject({ id: 'home-update', recordedBy: 'dev@example.com' });
  });

  it('returns questions and applies owner and surface filters', async () => {
    const all = await call('questions_list');
    expect(all.isError).toBeUndefined();
    expect(all.structuredContent).toMatchObject({ total: 2, shown: 2 });
    const mine = await call('questions_list', { mine: true, surface: 'HOME', limit: 1 });
    expect(mine.isError).toBeUndefined();
    expect(mine.structuredContent).toMatchObject({ filteredBy: { mine: 'dev@example.com', surface: 'HOME' } });
    const none = await call('questions_list', { mine: false, surface: 'missing', limit: 0 });
    expect(none.structuredContent).toMatchObject({ total: 2, shown: 0, questions: [] });
  });

  it('previews handoffs without writes and writes to the requested output when approved', async () => {
    const preview = await call('handoff_generate', { base: 'HEAD', out: 'docs/handoffs/preview.md', maxDepth: 2, dryRun: true });
    expect(preview.isError).toBeUndefined();
    await expect(fs.stat(path.join(root, 'docs/handoffs/preview.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    const generated = await call('handoff_generate');
    expect(generated.isError).toBeUndefined();
    expect(await fs.readFile(path.join(root, 'docs/handoffs/tester-handoff.md'), 'utf8')).toContain('Tester handoff');
  });
});

describe('MCP protocol and validation errors', () => {
  it.each([
    { params: undefined }, { params: {} }, { params: { name: 1 } },
    { params: { name: 'plans_list', arguments: null } },
    { params: { name: 'plans_list', arguments: [] } },
    { params: { name: 'plans_list', arguments: 'invalid' } },
  ])('rejects malformed tool parameters $params', async ({ params }) => {
    expect(await handleMcpRequest({ jsonrpc: '2.0', id: null, method: 'tools/call',
      ...(params === undefined ? {} : { params }) }, { cwd: root }))
      .toMatchObject({ id: null, error: { code: -32602, message: 'Invalid tools/call parameters.' } });
  });

  it.each([
    { name: 'graph_search', args: {}, text: "'text' must be a non-empty string" },
    { name: 'graph_search', args: { text: '' }, text: "'text' must be a non-empty string" },
    { name: 'graph_search', args: { text: 'home', kinds: 12 }, text: "'kinds' must be a non-empty string" },
    { name: 'graph_search', args: { text: 'home', limit: -1 }, text: 'non-negative integer' },
    { name: 'graph_search', args: { text: 'home', limit: 1.5 }, text: 'non-negative integer' },
    { name: 'graph_search', args: { text: 'home', limit: '1' }, text: 'non-negative integer' },
    { name: 'graph_path', args: { from: 'a', to: 'b', maxDepth: -1 }, text: 'non-negative integer' },
    { name: 'questions_list', args: { mine: 'true' }, text: "'mine' must be a boolean" },
    { name: 'handoff_generate', args: { dryRun: 1 }, text: "'dryRun' must be a boolean" },
    { name: 'plan_show', args: { id: 'missing' }, text: 'does not exist' },
    { name: 'graph_explain', args: { id: 'missing' }, text: 'missing' },
    { name: 'missing_tool', args: {}, text: "Unknown tool 'missing_tool'" },
  ])('returns a tool error for $name $args', async ({ name, args, text }) => {
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(text) });
    expect(result.structuredContent).toBeUndefined();
  });

  it.each([undefined, 'unsupported', 12])('negotiates a supported protocol when requested version is %s', async (protocolVersion) => {
    const result = await handleMcpRequest({ jsonrpc: '2.0', id: 'init', method: 'initialize',
      ...(protocolVersion === undefined ? {} : { params: { protocolVersion } }) }, { cwd: root });
    expect(result).toMatchObject({ id: 'init', result: { protocolVersion: '2025-11-25' } });
  });

  it('answers ping and ignores notifications even when their method is unknown', async () => {
    expect(await handleMcpRequest({ jsonrpc: '2.0', id: 0, method: 'ping' }, { cwd: root }))
      .toEqual({ jsonrpc: '2.0', id: 0, result: {} });
    expect(await handleMcpRequest({ jsonrpc: '2.0', method: 'unknown' }, { cwd: root })).toBeUndefined();
  });
});
