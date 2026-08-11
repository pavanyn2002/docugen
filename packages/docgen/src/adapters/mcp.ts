import fs from 'node:fs/promises';
import path from 'node:path';
import { DocgenError } from '../util/errors.js';

export const MCP_CONFIG_PATH = '.mcp.json';
export const CODEX_MCP_CONFIG_PATH = '.codex/config.toml';
const CODEX_START = '# >>> docgen MCP (managed) >>>';
const CODEX_END = '# <<< docgen MCP (managed) <<<';

export async function upsertMcpConfig(root: string, invocation: string): Promise<{ contents: string; action: 'created' | 'updated' | 'unchanged' }> {
  const file = path.join(root, MCP_CONFIG_PATH);
  let existing = '';
  try { existing = await fs.readFile(file, 'utf8'); } catch { /* absent */ }
  let document: Record<string, unknown> = {};
  if (existing.trim().length > 0) {
    try { document = JSON.parse(existing) as Record<string, unknown>; }
    catch (cause) {
      throw new DocgenError({
        code: 'mcp-config-invalid',
        message: `Cannot add docgen to invalid JSON in ${MCP_CONFIG_PATH}.`,
        remedy: 'Repair the JSON and rerun `docgen init`. The existing file was not changed.',
        file,
        cause,
      });
    }
  }
  const current = typeof document['mcpServers'] === 'object' && document['mcpServers'] !== null
    ? document['mcpServers'] as Record<string, unknown> : {};
  const words = invocation.split(/\s+/).filter(Boolean);
  const command = words[0] ?? 'docgen';
  const desired = { command, args: [...words.slice(1), 'mcp'] };
  const next = { ...document, mcpServers: { ...current, docgen: desired } };
  const contents = `${JSON.stringify(next, null, 2)}\n`;
  const normalised = existing.replace(/\r\n/g, '\n');
  return { contents, action: normalised === contents ? 'unchanged' : existing.length === 0 ? 'created' : 'updated' };
}

export async function upsertCodexMcpConfig(root: string, invocation: string): Promise<{ contents: string; action: 'created' | 'updated' | 'unchanged' }> {
  const file = path.join(root, CODEX_MCP_CONFIG_PATH);
  let existing = '';
  try { existing = await fs.readFile(file, 'utf8'); } catch { /* absent */ }
  const normalised = existing.replace(/\r\n/g, '\n');
  const start = normalised.indexOf(CODEX_START);
  const end = normalised.indexOf(CODEX_END);
  let outside = normalised;
  if (start >= 0 && end > start) outside = `${normalised.slice(0, start)}${normalised.slice(end + CODEX_END.length)}`;
  if (/^\s*\[mcp_servers\.docgen\]\s*$/m.test(outside)) {
    throw new DocgenError({
      code: 'codex-mcp-owned',
      message: `${CODEX_MCP_CONFIG_PATH} already defines mcp_servers.docgen outside the managed block.`,
      remedy: 'Remove or rename that team-owned table before rerunning `docgen init`. It was not overwritten.',
      file,
    });
  }
  const words = invocation.split(/\s+/).filter(Boolean);
  const command = words[0] ?? 'docgen';
  const args = [...words.slice(1), 'mcp'];
  const block = [
    CODEX_START,
    '[mcp_servers.docgen]',
    `command = ${JSON.stringify(command)}`,
    `args = ${JSON.stringify(args)}`,
    'default_tools_approval_mode = "writes"',
    CODEX_END,
  ].join('\n');
  const prefix = outside.trimEnd();
  const contents = `${prefix.length === 0 ? '' : `${prefix}\n\n`}${block}\n`;
  return { contents, action: normalised === contents ? 'unchanged' : existing.length === 0 ? 'created' : 'updated' };
}
