import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DocgenError, describeUnknownError } from '../util/errors.js';
import { compareStrings } from '../util/sort.js';
import { writeFileAtomically } from '../util/atomic.js';
import { EVIDENCE_GRAPH_SCHEMA_VERSION } from './types.js';
import {
  GLOBAL_GRAPH_PARTITION,
  GRAPH_PARTITION_SCHEMA_VERSION,
  mergeGraphPartitions,
} from './partitions.js';
import type { GraphPartitionManifest } from './partitions.js';
import { graphEdgeSchema, graphGapSchema, graphNodeSchema } from './store.js';

export const DEFAULT_GRAPH_PARTITION_INDEX = '.docgen/cache/graph-partitions.json';

const partitionSchema = z
  .object({
    key: z.string().min(1),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    nodes: z.array(graphNodeSchema).readonly(),
    edges: z.array(graphEdgeSchema).readonly(),
    gaps: z.array(graphGapSchema).readonly(),
  })
  .strict();

const manifestSchema = z
  .object({
    schemaVersion: z.literal(GRAPH_PARTITION_SCHEMA_VERSION),
    graphSchemaVersion: z.literal(EVIDENCE_GRAPH_SCHEMA_VERSION),
    engineVersion: z.string().min(1),
    includeSymbols: z.boolean(),
    configSha256: z.string().regex(/^[a-f0-9]{64}$/),
    symbolAdaptersSha256: z.string().regex(/^[a-f0-9]{64}$/),
    partitions: z.array(partitionSchema).readonly(),
  })
  .strict();

export function serialiseGraphPartitions(manifest: GraphPartitionManifest): string {
  const canonical = {
    ...manifest,
    partitions: [...manifest.partitions]
      .sort((a, b) => compareStrings(a.key, b.key))
      .map((partition) => ({
        ...partition,
        nodes: [...partition.nodes].sort((a, b) => compareStrings(a.id, b.id)),
        edges: [...partition.edges].sort((a, b) => compareStrings(a.id, b.id)),
      })),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function parseGraphPartitions(contents: string, file = 'graph partition index'): GraphPartitionManifest {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (cause) {
    throw new DocgenError({
      code: 'graph-partitions-unparseable',
      message: `${file} is not valid JSON: ${describeUnknownError(cause)}`,
      remedy: 'Delete the rebuildable partition index and run `docgen index` again.',
      file,
      cause,
    });
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new DocgenError({
      code: 'graph-partitions-schema-invalid',
      message: `${file} does not match graph partition schema v${GRAPH_PARTITION_SCHEMA_VERSION}: ${parsed.error.issues[0]?.message ?? 'invalid shape'}.`,
      remedy: 'Delete the rebuildable partition index and run `docgen index` again.',
      file,
    });
  }
  const manifest = parsed.data as GraphPartitionManifest;
  const keys = manifest.partitions.map((partition) => partition.key);
  if (new Set(keys).size !== keys.length) {
    throw new DocgenError({
      code: 'graph-partitions-duplicate-key',
      message: `${file} contains duplicate partition keys.`,
      remedy: 'Delete the rebuildable partition index and run `docgen index` again.',
      file,
    });
  }
  try {
    mergeGraphPartitions(manifest);
  } catch (cause) {
    throw new DocgenError({
      code: 'graph-partitions-invalid',
      message: `${file} cannot reconstruct a valid evidence graph.`,
      remedy: 'Delete the rebuildable partition index and run `docgen index` again.',
      file,
      cause,
    });
  }
  return {
    ...manifest,
    partitions: [...manifest.partitions].sort((a, b) => compareStrings(a.key, b.key)),
  };
}

export async function readGraphPartitions(file: string): Promise<GraphPartitionManifest | undefined> {
  try {
    return parseGraphPartitions(await fs.readFile(file, 'utf8'), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeGraphPartitions(
  file: string,
  manifest: GraphPartitionManifest,
): Promise<{ readonly file: string; readonly bytes: number; readonly sha256: string }> {
  // Validate before touching the last known-good cache.
  mergeGraphPartitions(manifest);
  const contents = serialiseGraphPartitions(manifest);
  const absolute = path.resolve(file);
  try {
    await writeFileAtomically(absolute, contents);
  } catch (cause) {
    throw new DocgenError({
      code: 'graph-partitions-write-failed',
      message: `Could not write graph partition index: ${absolute}.`,
      remedy: 'Check directory permissions and retry indexing.',
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

export { GLOBAL_GRAPH_PARTITION };
