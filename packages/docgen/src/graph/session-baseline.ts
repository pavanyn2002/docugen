import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { writeFileAtomically } from '../util/atomic.js';
import { DocgenError } from '../util/errors.js';
import { DEFAULT_GRAPH_INDEX, parseEvidenceGraph, readEvidenceGraphIfExists } from './store.js';
import type { EvidenceGraph } from './types.js';

const execFileAsync = promisify(execFile);
export const SESSION_BASELINE_FILE = '.docgen/cache/session-baseline.json';
const recordSchema = z.object({ schemaVersion: z.literal(1), revision: z.string().regex(/^[a-f0-9]{40,64}$/), graph: z.unknown() }).strict();

async function revision(root: string, base: string): Promise<string | undefined> {
  if (base.startsWith('-') || /[\r\n\0]/.test(base)) return undefined;
  try {
    const result = await execFileAsync('git', ['rev-parse', '--verify', `${base}^{object}`], { cwd: root, timeout: 5_000, windowsHide: true });
    const sha = result.stdout.trim();
    return /^[a-f0-9]{40,64}$/.test(sha) ? sha : undefined;
  } catch {
    // Indexing also works without Git. Git-dependent callers validate their base separately.
    return undefined;
  }
}

async function readRecord(root: string): Promise<{ revision: string; graph: EvidenceGraph } | undefined> {
  const file = path.join(root, SESSION_BASELINE_FILE);
  try {
    const parsed = recordSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
    return { revision: parsed.revision, graph: parseEvidenceGraph(JSON.stringify(parsed.graph), file) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new DocgenError({ code: 'graph-session-baseline-invalid', message: 'The cached session baseline is invalid.', remedy: 'Delete .docgen/cache/session-baseline.json and restart the session.', file, cause: error });
  }
}

/** Keep the first graph for a comparison revision; repeated edits must not erase deletions. */
export async function preserveSessionBaseline(root: string, base: string): Promise<void> {
  const sha = await revision(root, base);
  if (sha === undefined) return;
  const existing = await readRecord(root);
  if (existing?.revision === sha) return;
  // Preserve the last extracted evidence before replacing the index, including
  // after a commit advances the comparison revision. It may still contain code
  // deleted since that commit; the freshly rebuilt graph cannot recover it.
  const graph = await readEvidenceGraphIfExists(path.join(root, DEFAULT_GRAPH_INDEX));
  if (graph === undefined) return;
  await writeFileAtomically(path.join(root, SESSION_BASELINE_FILE), `${JSON.stringify({ schemaVersion: 1, revision: sha, graph }, null, 2)}\n`);
}

export async function readImpactBaseline(root: string, base = 'HEAD'): Promise<EvidenceGraph | undefined> {
  const existing = await readRecord(root);
  if (existing !== undefined && existing.revision === await revision(root, base)) return existing.graph;
  return readEvidenceGraphIfExists(path.join(root, DEFAULT_GRAPH_INDEX));
}
