import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBoundaryViolations } from '../src/util/boundaries.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(TEST_DIR, '..', 'src');

describe('static/LLM import boundary', () => {
  it('the real source tree has no violations', async () => {
    const violations = await findBoundaryViolations(SRC_ROOT);
    expect(violations).toEqual([]);
  });

  it('detects a static-lane module importing the LLM lane', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-boundary-'));
    await fs.mkdir(path.join(tmp, 'extract'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'agents'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'agents', 'claude.ts'), 'export const ask = () => null;\n');
    await fs.writeFile(
      path.join(tmp, 'extract', 'routes.ts'),
      "import { ask } from '../agents/claude.js';\nexport const run = ask;\n",
    );

    const violations = await findBoundaryViolations(tmp);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: 'extract/routes.ts',
      line: 1,
      specifier: '../agents/claude.js',
    });

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('detects a dynamic import across the boundary', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-boundary-'));
    await fs.mkdir(path.join(tmp, 'extract'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'infer'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'infer', 'cards.ts'), 'export const x = 1;\n');
    await fs.writeFile(
      path.join(tmp, 'extract', 'schema.ts'),
      "export async function run() {\n  const m = await import('../infer/cards.js');\n  return m;\n}\n",
    );

    const violations = await findBoundaryViolations(tmp);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(2);

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('allows imports within the static lane', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-boundary-'));
    await fs.mkdir(path.join(tmp, 'extract'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'util'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'util', 'paths.ts'), 'export const toPosix = (s: string) => s;\n');
    await fs.writeFile(
      path.join(tmp, 'extract', 'deps.ts'),
      "import { toPosix } from '../util/paths.js';\nexport const run = toPosix;\n",
    );

    await expect(findBoundaryViolations(tmp)).resolves.toEqual([]);

    await fs.rm(tmp, { recursive: true, force: true });
  });
});
