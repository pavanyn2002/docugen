import { loadConfig } from '../config/load.js';
import { EvidenceGraphIndex } from '../graph/query.js';
import {
  GRAPH_EDGE_KINDS,
  GRAPH_NODE_KINDS,
} from '../graph/types.js';
import type { GraphDirection, GraphNeighbor } from '../graph/query.js';
import type { GraphEdgeKind, GraphNodeKind } from '../graph/types.js';
import { runExtraction } from '../pipeline.js';
import { colors } from '../util/colors.js';
import { DocgenError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

interface GraphCommandBase {
  readonly cwd: string;
  readonly configFile?: string;
  readonly json?: boolean;
  readonly logger: Logger;
}

export interface GraphSearchCommandOptions extends GraphCommandBase {
  readonly text: string;
  readonly kinds?: string;
  readonly limit?: number;
}

export interface GraphExplainCommandOptions extends GraphCommandBase {
  readonly id: string;
}

export interface GraphPathCommandOptions extends GraphCommandBase {
  readonly from: string;
  readonly to: string;
  readonly direction?: string;
  readonly edgeKinds?: string;
  readonly maxDepth?: number;
}

function parseList<T extends string>(
  value: string | undefined,
  valid: readonly T[],
  label: string,
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  const requested = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  const unknown = requested.filter((item) => !valid.includes(item as T));
  if (unknown.length > 0) {
    throw new DocgenError({
      code: `graph-${label}-unknown`,
      message: `Unknown graph ${label}(s): ${unknown.join(', ')}.`,
      remedy: `Valid values are: ${valid.join(', ')}.`,
    });
  }
  return requested.map((item) => valid.find((candidate) => candidate === item) as T);
}

export function parseGraphNodeKinds(value: string | undefined): readonly GraphNodeKind[] | undefined {
  return parseList(value, GRAPH_NODE_KINDS, 'node-kind');
}

export function parseGraphEdgeKinds(value: string | undefined): readonly GraphEdgeKind[] | undefined {
  return parseList(value, GRAPH_EDGE_KINDS, 'edge-kind');
}

export function parseGraphDirection(value: string | undefined): GraphDirection {
  const resolved = value ?? 'outgoing';
  if (resolved === 'incoming' || resolved === 'outgoing' || resolved === 'both') return resolved;
  throw new DocgenError({
    code: 'graph-direction-unknown',
    message: `Unknown graph direction '${resolved}'.`,
    remedy: 'Valid values are: incoming, outgoing, both.',
  });
}

async function liveIndex(options: GraphCommandBase): Promise<EvidenceGraphIndex> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const run = await runExtraction({ config, logger: options.logger, includeSymbols: true });
  return new EvidenceGraphIndex(run.graph);
}

function renderNeighbor(item: GraphNeighbor): string {
  const arrow = item.direction === 'outgoing' ? '->' : '<-';
  return `${arrow} ${item.edge.kind} ${item.node.id} (${item.node.label})`;
}

export async function runGraphSearchCommand(options: GraphSearchCommandOptions): Promise<void> {
  const index = await liveIndex(options);
  const kinds = parseGraphNodeKinds(options.kinds);
  const nodes = index.search({
    text: options.text,
    ...(kinds === undefined ? {} : { kinds }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });

  if (options.json === true) {
    options.logger.output(JSON.stringify({ query: options.text, count: nodes.length, nodes }, null, 2));
    return;
  }
  options.logger.heading(`Graph search (${nodes.length})`);
  for (const node of nodes) options.logger.info(`  ${node.id}  ${colors().dim(node.label)}`);
  if (nodes.length === 0) options.logger.info(`  ${colors().dim('no matching nodes')}`);
}

export async function runGraphExplainCommand(options: GraphExplainCommandOptions): Promise<void> {
  const explanation = (await liveIndex(options)).explain(options.id);
  if (options.json === true) {
    options.logger.output(JSON.stringify(explanation, null, 2));
    return;
  }

  options.logger.heading(explanation.node.label);
  options.logger.info(`  id         ${explanation.node.id}`);
  options.logger.info(`  kind       ${explanation.node.kind}`);
  options.logger.info(`  provenance ${explanation.node.provenance.origin}`);
  for (const ref of explanation.node.provenance.evidence) {
    options.logger.info(`  evidence   ${ref.file}${ref.line === undefined ? '' : `:${ref.line}`}`);
  }
  options.logger.heading(`Relationships (${explanation.incoming.length + explanation.outgoing.length})`);
  for (const item of [...explanation.incoming, ...explanation.outgoing]) {
    options.logger.info(`  ${renderNeighbor(item)}`);
  }
}

export async function runGraphPathCommand(options: GraphPathCommandOptions): Promise<void> {
  const index = await liveIndex(options);
  const edgeKinds = parseGraphEdgeKinds(options.edgeKinds);
  const path = index.findPath(options.from, options.to, {
    direction: parseGraphDirection(options.direction),
    ...(edgeKinds === undefined ? {} : { edgeKinds }),
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
  });

  if (options.json === true) {
    options.logger.output(JSON.stringify({ from: options.from, to: options.to, found: path !== undefined, path }, null, 2));
    return;
  }
  if (path === undefined) {
    options.logger.heading('No graph path');
    options.logger.info(`  ${options.from} -> ${options.to}`);
    return;
  }

  options.logger.heading(`Graph path (${path.edges.length} edge${path.edges.length === 1 ? '' : 's'})`);
  options.logger.info(`  ${path.nodes[0]?.id ?? options.from}`);
  for (const [indexAt, edge] of path.edges.entries()) {
    const next = path.nodes[indexAt + 1];
    options.logger.info(`    --${edge.kind}--> ${next?.id ?? edge.to}`);
  }
}
