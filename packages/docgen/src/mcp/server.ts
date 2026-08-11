import readline from 'node:readline';
import { runAskCommand } from '../commands/ask.js';
import { runHandoffCommand } from '../commands/handoff.js';
import { runImpactCommand } from '../commands/impact.js';
import { runPlanListCommand, runPlanShowCommand } from '../commands/plan.js';
import { runGraphExplainCommand, runGraphPathCommand, runGraphSearchCommand } from '../commands/query-graph.js';
import { captureJson } from '../util/capture.js';
import { describeUnknownError } from '../util/errors.js';
import { ENGINE_VERSION } from '../util/version.js';

type JsonObject = Record<string, unknown>;
interface McpRequest { readonly jsonrpc: '2.0'; readonly id?: string | number | null; readonly method: string; readonly params?: JsonObject; }
interface McpContext { readonly cwd: string; readonly configFile?: string; }

const tools = [
  { name: 'graph_search', description: 'Search code-evidence graph nodes by id or label.', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: 'object', properties: { text: { type: 'string' }, kinds: { type: 'string' }, limit: { type: 'integer', minimum: 0 } }, required: ['text'], additionalProperties: false } },
  { name: 'graph_explain', description: 'Explain one graph node with evidence and relationships.', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'graph_path', description: 'Find an evidence path between two graph nodes.', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, direction: { enum: ['incoming', 'outgoing', 'both'] }, edgeKinds: { type: 'string' }, maxDepth: { type: 'integer', minimum: 0 } }, required: ['from', 'to'], additionalProperties: false } },
  { name: 'change_impact', description: 'Report graph entities affected by Git changes.', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: 'object', properties: { base: { type: 'string' }, maxDepth: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
  { name: 'plans_list', description: 'List governed feature plans and their states.', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'plan_show', description: 'Read one governed feature plan.', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'questions_list', description: 'List unresolved developer questions. Never answer them automatically.', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: 'object', properties: { mine: { type: 'boolean' }, surface: { type: 'string' }, limit: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
  { name: 'handoff_generate', description: 'Generate the tester handoff for current Git changes. This writes docs/handoffs/tester-handoff.md unless dryRun is true.', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, inputSchema: { type: 'object', properties: { base: { type: 'string' }, out: { type: 'string' }, maxDepth: { type: 'integer', minimum: 0 }, dryRun: { type: 'boolean' } }, additionalProperties: false } },
] as const;

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

function stringArg(args: JsonObject, key: string, required = false): string | undefined {
  const value = args[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (value === undefined && !required) return undefined;
  throw new Error(`'${key}' must be a non-empty string.`);
}
function numberArg(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  throw new Error(`'${key}' must be a non-negative integer.`);
}
function booleanArg(args: JsonObject, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || typeof value === 'boolean') return value;
  throw new Error(`'${key}' must be a boolean.`);
}

async function callTool(name: string, args: JsonObject, context: McpContext): Promise<unknown> {
  const base = { cwd: context.cwd, ...(context.configFile === undefined ? {} : { configFile: context.configFile }), json: true } as const;
  switch (name) {
    case 'graph_search': {
      const kinds = stringArg(args, 'kinds'); const limit = numberArg(args, 'limit');
      return captureJson((logger) => runGraphSearchCommand({ ...base, logger, text: stringArg(args, 'text', true) as string, ...(kinds === undefined ? {} : { kinds }), ...(limit === undefined ? {} : { limit }) }));
    }
    case 'graph_explain': return captureJson((logger) => runGraphExplainCommand({ ...base, logger, id: stringArg(args, 'id', true) as string }));
    case 'graph_path': {
      const direction = stringArg(args, 'direction'); const edgeKinds = stringArg(args, 'edgeKinds'); const maxDepth = numberArg(args, 'maxDepth');
      return captureJson((logger) => runGraphPathCommand({ ...base, logger, from: stringArg(args, 'from', true) as string, to: stringArg(args, 'to', true) as string, ...(direction === undefined ? {} : { direction }), ...(edgeKinds === undefined ? {} : { edgeKinds }), ...(maxDepth === undefined ? {} : { maxDepth }) }));
    }
    case 'change_impact': {
      const gitBase = stringArg(args, 'base'); const maxDepth = numberArg(args, 'maxDepth'); const limit = numberArg(args, 'limit');
      return captureJson((logger) => runImpactCommand({ ...base, logger, ...(gitBase === undefined ? {} : { base: gitBase }), ...(maxDepth === undefined ? {} : { maxDepth }), ...(limit === undefined ? {} : { limit }) }));
    }
    case 'plans_list': return captureJson((logger) => runPlanListCommand({ ...base, logger }));
    case 'plan_show': return captureJson((logger) => runPlanShowCommand({ ...base, logger, id: stringArg(args, 'id', true) as string }));
    case 'questions_list': {
      const surface = stringArg(args, 'surface'); const limit = numberArg(args, 'limit');
      return captureJson((logger) => runAskCommand({ ...base, logger, mine: booleanArg(args, 'mine') === true, ...(surface === undefined ? {} : { surface }), ...(limit === undefined ? {} : { limit }) }));
    }
    case 'handoff_generate': {
      const gitBase = stringArg(args, 'base'); const out = stringArg(args, 'out'); const maxDepth = numberArg(args, 'maxDepth');
      return captureJson((logger) => runHandoffCommand({ ...base, logger, ...(gitBase === undefined ? {} : { base: gitBase }), ...(out === undefined ? {} : { out }), ...(maxDepth === undefined ? {} : { maxDepth }), dryRun: booleanArg(args, 'dryRun') === true }));
    }
    default: throw new Error(`Unknown tool '${name}'.`);
  }
}

function response(id: McpRequest['id'], result: unknown): JsonObject { return { jsonrpc: '2.0', id: id ?? null, result }; }
function errorResponse(id: McpRequest['id'], code: number, message: string): JsonObject { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

export async function handleMcpRequest(request: McpRequest, context: McpContext): Promise<JsonObject | undefined> {
  if (request.id === undefined) return undefined;
  if (request.method === 'initialize') {
    const requested = request.params?.['protocolVersion'];
    const protocolVersion =
      typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.some((version) => version === requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
    return response(request.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'docgen', version: ENGINE_VERSION },
      instructions: 'Use read-only evidence tools while coding. Generate a handoff before completing work. Never invent answers to developer questions.',
    });
  }
  if (request.method === 'ping') return response(request.id, {});
  if (request.method === 'tools/list') return response(request.id, { tools });
  if (request.method === 'tools/call') {
    const name = request.params?.['name'];
    const args = request.params?.['arguments'];
    if (typeof name !== 'string' || (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args)))) return errorResponse(request.id, -32602, 'Invalid tools/call parameters.');
    try {
      const value = await callTool(name, (args ?? {}) as JsonObject, context);
      return response(request.id, { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value ?? {} });
    } catch (error) {
      return response(request.id, { content: [{ type: 'text', text: describeUnknownError(error) }], isError: true });
    }
  }
  return errorResponse(request.id, -32601, `Method not found: ${request.method}`);
}

export async function runMcpServer(context: McpContext): Promise<void> {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  lines.on('line', (line) => {
    chain = chain.then(async () => {
      let request: McpRequest;
      try { request = JSON.parse(line) as McpRequest; }
      catch { process.stdout.write(`${JSON.stringify(errorResponse(null, -32700, 'Parse error'))}\n`); return; }
      const result = await handleMcpRequest(request, context);
      if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch((error) => { process.stderr.write(`docgen mcp: ${describeUnknownError(error)}\n`); });
  });
  await new Promise<void>((resolve) => lines.once('close', resolve));
  await chain;
}
