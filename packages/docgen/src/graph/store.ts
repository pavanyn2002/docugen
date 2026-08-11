import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { EXTRACTOR_IDS } from '../types/core.js';
import { DocgenError, describeUnknownError } from '../util/errors.js';
import { validateEvidenceGraph } from './builder.js';
import { serialiseEvidenceGraph } from './serialize.js';
import {
  EVIDENCE_GRAPH_SCHEMA_VERSION,
  GRAPH_EDGE_KINDS,
  GRAPH_NODE_KINDS,
} from './types.js';
import type { EvidenceGraph } from './types.js';

export const DEFAULT_GRAPH_INDEX = '.docgen/cache/evidence-graph.json';

const sourceRefSchema = z
  .object({
    file: z.string().min(1),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .strict();

const propertyValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()).readonly(),
]);

const provenanceSchema = z
  .object({
    origin: z.enum(['extracted', 'inferred', 'human']),
    evidence: z.array(sourceRefSchema).readonly(),
    extractors: z.array(z.enum(EXTRACTOR_IDS)).readonly().optional(),
    extractionMethods: z
      .array(z.enum(['ast', 'manifest', 'schema', 'config', 'regex']))
      .readonly()
      .optional(),
    certainty: z.enum(['high', 'low']).optional(),
    actor: z.string().min(1).optional(),
    recordedAt: z.string().min(1).optional(),
  })
  .strict();

export const graphNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(GRAPH_NODE_KINDS),
    label: z.string(),
    provenance: provenanceSchema,
    properties: z.record(propertyValueSchema).optional(),
  })
  .strict();

export const graphEdgeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(GRAPH_EDGE_KINDS),
    from: z.string().min(1),
    to: z.string().min(1),
    provenance: provenanceSchema,
    properties: z.record(propertyValueSchema).optional(),
  })
  .strict();

export const graphGapSchema = z
  .object({
    extractor: z.enum([...EXTRACTOR_IDS, 'surface', 'symbol']),
    kind: z.string().min(1),
    message: z.string().min(1),
    source: sourceRefSchema.optional(),
  })
  .strict();

const evidenceGraphSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_GRAPH_SCHEMA_VERSION),
    nodes: z.array(graphNodeSchema).readonly(),
    edges: z.array(graphEdgeSchema).readonly(),
    gaps: z.array(graphGapSchema).readonly(),
  })
  .strict();

export interface GraphWriteResult {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Keep the default rebuildable cache out of commits without editing a repo's root ignore file. */
export async function ensureDefaultGraphCacheIgnored(root: string): Promise<boolean> {
  const directory = path.join(root, path.dirname(DEFAULT_GRAPH_INDEX));
  const file = path.join(directory, '.gitignore');
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(file, '*\n!.gitignore\n', { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

export function parseEvidenceGraph(contents: string, file = 'evidence graph'): EvidenceGraph {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (cause) {
    throw new DocgenError({
      code: 'graph-index-unparseable',
      message: `${file} is not valid JSON: ${describeUnknownError(cause)}`,
      remedy: 'Delete the rebuildable graph index and run indexing again.',
      file,
      cause,
    });
  }

  const parsed = evidenceGraphSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new DocgenError({
      code: 'graph-index-schema-invalid',
      message: `${file} does not match evidence graph schema v${EVIDENCE_GRAPH_SCHEMA_VERSION}: ${first?.message ?? 'invalid shape'}.`,
      remedy: 'Delete the rebuildable graph index and run indexing again.',
      file,
    });
  }

  const graph = parsed.data as EvidenceGraph;
  const issues = validateEvidenceGraph(graph);
  if (issues.length > 0) {
    throw new DocgenError({
      code: 'graph-index-invalid',
      message: `${file} contains an invalid relationship: ${issues[0]?.message ?? 'unknown validation failure'}`,
      remedy: 'Delete the rebuildable graph index and run indexing again.',
      file,
    });
  }
  return graph;
}

export async function readEvidenceGraph(file: string): Promise<EvidenceGraph> {
  let contents: string;
  try {
    contents = await fs.readFile(file, 'utf8');
  } catch (cause) {
    throw new DocgenError({
      code: 'graph-index-unreadable',
      message: `Could not read evidence graph index: ${file}.`,
      remedy: 'Run indexing to create the local graph cache, then retry the query.',
      file,
      cause,
    });
  }
  return parseEvidenceGraph(contents, file);
}

/** Read a rebuildable index when present; malformed existing input still fails loudly. */
export async function readEvidenceGraphIfExists(file: string): Promise<EvidenceGraph | undefined> {
  try {
    return parseEvidenceGraph(await fs.readFile(file, 'utf8'), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Write canonical bytes through a sibling temporary file, then replace atomically. */
export async function writeEvidenceGraph(file: string, graph: EvidenceGraph): Promise<GraphWriteResult> {
  const contents = serialiseEvidenceGraph(graph);
  const absolute = path.resolve(file);
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(absolute), { recursive: true });

  try {
    await fs.writeFile(temporary, contents, 'utf8');
    await fs.rename(temporary, absolute);
  } catch (cause) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw new DocgenError({
      code: 'graph-index-write-failed',
      message: `Could not write evidence graph index: ${absolute}.`,
      remedy: 'Check directory permissions and that no process has locked the index, then retry.',
      file: absolute,
      cause,
    });
  }

  return {
    file: absolute,
    bytes: Buffer.byteLength(contents),
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}
