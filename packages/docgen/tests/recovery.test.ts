import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEvidenceGraph } from '../src/graph/store.js';
import { serialiseEvidenceGraph } from '../src/graph/serialize.js';
import {
  ATOMIC_TEMP_MARKER,
  findStaleAtomicFiles,
  removeAtomicFiles,
  writeFileAtomically,
} from '../src/util/atomic.js';

const created: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-recovery-'));
  created.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('artifact compatibility', () => {
  it('keeps the evidence graph v1 byte-for-byte compatible with its golden file', async () => {
    const golden = await fs.readFile(
      path.join(import.meta.dirname, 'golden', 'evidence-graph.v1.json'),
      'utf8',
    );
    expect(serialiseEvidenceGraph(parseEvidenceGraph(golden))).toBe(golden);
  });

  it('rejects a future graph schema without rewriting the artifact', async () => {
    const root = await temporaryRoot();
    const file = path.join(root, 'evidence-graph.json');
    const future = '{"schemaVersion":999,"nodes":[],"edges":[],"gaps":[]}\n';
    await fs.writeFile(file, future, 'utf8');
    expect(() => parseEvidenceGraph(future, file)).toThrow(/schema v1/);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(future);
  });
});

describe('interrupted-write recovery', () => {
  it('preserves the last good target and cleans temporary bytes when publication fails', async () => {
    const root = await temporaryRoot();
    const file = path.join(root, 'state.json');
    await fs.writeFile(file, 'last-good\n', 'utf8');

    await expect(
      writeFileAtomically(file, 'replacement\n', {
        beforePublish: () => {
          throw new Error('simulated process interruption');
        },
      }),
    ).rejects.toThrow(/simulated process interruption/);

    await expect(fs.readFile(file, 'utf8')).resolves.toBe('last-good\n');
    expect((await fs.readdir(root)).filter((entry) => entry.includes(ATOMIC_TEMP_MARKER))).toEqual([]);
  });

  it('finds and removes only stale Docgen temporary files', async () => {
    const root = await temporaryRoot();
    const stale = path.join(root, `record.json${ATOMIC_TEMP_MARKER}old`);
    const current = path.join(root, `record.json${ATOMIC_TEMP_MARKER}current`);
    const unrelated = path.join(root, 'record.json.tmp');
    await Promise.all([
      fs.writeFile(stale, 'stale', 'utf8'),
      fs.writeFile(current, 'current', 'utf8'),
      fs.writeFile(unrelated, 'keep', 'utf8'),
    ]);
    await fs.utimes(stale, new Date(0), new Date(0));

    const files = await findStaleAtomicFiles(root, { olderThanMs: 1_000, now: Date.now() });
    expect(files).toEqual([path.basename(stale)]);
    await removeAtomicFiles(root, files);
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(current, 'utf8')).resolves.toBe('current');
    await expect(fs.readFile(unrelated, 'utf8')).resolves.toBe('keep');
  });
});
