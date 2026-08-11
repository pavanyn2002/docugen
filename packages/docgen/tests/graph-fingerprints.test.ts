import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  diffFileFingerprints,
  fingerprintFiles,
  parseFileFingerprints,
  readFileFingerprints,
  serialiseFileFingerprints,
  writeFileFingerprints,
} from '../src/graph/fingerprints.js';

describe('file fingerprint manifest', () => {
  it('hashes the configured file boundary deterministically', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-fingerprints-'));
    try {
      await fs.mkdir(path.join(root, 'src'));
      await fs.mkdir(path.join(root, 'ignored'));
      await fs.mkdir(path.join(root, 'docs', '.features'), { recursive: true });
      await fs.writeFile(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');
      await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      await fs.writeFile(path.join(root, 'ignored', 'secret.ts'), 'ignored\n');
      await fs.writeFile(path.join(root, 'docs', '.features', 'checkout.json'), '{}\n');

      const first = await fingerprintFiles({
        root,
        include: ['**/*.ts'],
        exclude: ['ignored/**', 'docs/.features/**'],
        additionalInclude: ['docs/.features/**/*.json'],
      });
      const second = await fingerprintFiles({
        root,
        include: ['**/*.ts'],
        exclude: ['ignored/**', 'docs/.features/**'],
        additionalInclude: ['docs/.features/**/*.json'],
      });

      expect(first.files.map((entry) => entry.file)).toEqual([
        'docs/.features/checkout.json',
        'src/a.ts',
        'src/b.ts',
      ]);
      expect(serialiseFileFingerprints(first)).toBe(serialiseFileFingerprints(second));
      expect(first.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('detects additions, content changes, deletions, and unchanged files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-fingerprint-diff-'));
    try {
      await fs.writeFile(path.join(root, 'changed.ts'), 'before\n');
      await fs.writeFile(path.join(root, 'deleted.ts'), 'delete me\n');
      await fs.writeFile(path.join(root, 'same.ts'), 'stable\n');
      const before = await fingerprintFiles({ root, include: ['**/*.ts'], exclude: [] });

      await fs.writeFile(path.join(root, 'changed.ts'), 'after\n');
      await fs.rm(path.join(root, 'deleted.ts'));
      await fs.writeFile(path.join(root, 'added.ts'), 'new\n');
      const after = await fingerprintFiles({ root, include: ['**/*.ts'], exclude: [] });

      expect(diffFileFingerprints(before, after)).toEqual({
        added: ['added.ts'],
        changed: ['changed.ts'],
        deleted: ['deleted.ts'],
        unchanged: ['same.ts'],
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('atomically writes and schema-validates manifests', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-fingerprint-store-'));
    const file = path.join(root, 'cache', 'fingerprints.json');
    try {
      await fs.writeFile(path.join(root, 'source.ts'), 'source\n');
      const manifest = await fingerprintFiles({ root, include: ['*.ts'], exclude: [] });
      const first = await writeFileFingerprints(file, manifest);
      const second = await writeFileFingerprints(file, manifest);

      expect(first.sha256).toBe(second.sha256);
      expect(await readFileFingerprints(file)).toEqual(manifest);
      expect(await readFileFingerprints(path.join(root, 'missing.json'))).toBeUndefined();
      expect(() => parseFileFingerprints('{broken')).toThrow(/not valid JSON/);
      expect(() => parseFileFingerprints('{"schemaVersion":99,"files":[]}')).toThrow(/schema v1/);
      expect((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
