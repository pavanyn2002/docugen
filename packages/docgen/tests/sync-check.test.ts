import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runExtractCommand } from '../src/commands/extract.js';
import { runSyncCommand } from '../src/commands/sync.js';
import { runCheckCommand } from '../src/commands/check.js';
import { createLogger } from '../src/util/logger.js';
import { DocgenError } from '../src/util/errors.js';

const created: string[] = [];
const quiet = createLogger({ level: 'error' });

/** Captures stdout so a --json payload can be asserted on. */
function capture(): { logger: ReturnType<typeof createLogger>; json: () => unknown } {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  return {
    logger: createLogger({ level: 'error', stdout: stream }),
    json: () => JSON.parse(chunks.join('')),
  };
}

/** A minimal repo docgen finds something in, so there is output to check. */
async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-sync-'));
  created.push(dir);

  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', dependencies: { next: '^15.0.0' } }),
    'app/page.tsx': 'export default function Home() {\n  return null;\n}\n',
    'app/orders/page.tsx': 'export default function Orders() {\n  return null;\n}\n',
  };

  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }
  return dir;
}

async function generate(root: string): Promise<void> {
  await runExtractCommand({ cwd: root, dryRun: false, json: false, logger: quiet });
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('docgen check', () => {
  it('passes on freshly generated documentation', async () => {
    const root = await makeRepo();
    await generate(root);

    await expect(runCheckCommand({ cwd: root, json: false, logger: quiet })).resolves.toBeUndefined();
  });

  it('fails when a generated page has been edited by hand', async () => {
    const root = await makeRepo();
    await generate(root);
    await fs.appendFile(path.join(root, 'docs/generated/routes.md'), '\nEdited by hand.\n', 'utf8');

    await expect(runCheckCommand({ cwd: root, json: false, logger: quiet })).rejects.toThrow(
      /out of date/,
    );
  });

  it('fails when a generated page has been deleted', async () => {
    const root = await makeRepo();
    await generate(root);
    await fs.rm(path.join(root, 'docs/generated/routes.md'));

    await expect(runCheckCommand({ cwd: root, json: false, logger: quiet })).rejects.toThrow(
      DocgenError,
    );
  });

  it('fails when the code changed but the docs were not regenerated', async () => {
    const root = await makeRepo();
    await generate(root);
    await fs.mkdir(path.join(root, 'app/invoices'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'app/invoices/page.tsx'),
      'export default function Invoices() {\n  return null;\n}\n',
      'utf8',
    );

    await expect(runCheckCommand({ cwd: root, json: false, logger: quiet })).rejects.toThrow(
      /out of date/,
    );
  });

  it('reports a page left behind for something that no longer exists', async () => {
    const root = await makeRepo();
    await generate(root);
    await fs.writeFile(path.join(root, 'docs/generated/orphan.md'), '# gone\n', 'utf8');

    const captured = capture();
    await expect(
      runCheckCommand({ cwd: root, json: true, logger: captured.logger }),
    ).rejects.toThrow(DocgenError);

    expect((captured.json() as { drift: unknown[] }).drift).toContainEqual({
      file: 'docs/generated/orphan.md',
      kind: 'orphaned',
    });
  });

  it('does not fail on unanswered questions unless asked to', async () => {
    const root = await makeRepo();
    await generate(root);

    await expect(runCheckCommand({ cwd: root, json: false, logger: quiet })).resolves.toBeUndefined();
  });
});

describe('docgen sync', () => {
  it('brings stale documentation back up to date', async () => {
    const root = await makeRepo();
    await generate(root);
    await fs.appendFile(path.join(root, 'docs/generated/routes.md'), '\nstale\n', 'utf8');

    await runSyncCommand({ cwd: root, json: false, logger: quiet });

    await expect(runCheckCommand({ cwd: root, json: false, logger: quiet })).resolves.toBeUndefined();
  });

  it('writes nothing when everything is already current', async () => {
    const root = await makeRepo();
    await generate(root);

    const captured = capture();
    await runSyncCommand({ cwd: root, json: true, logger: captured.logger });

    expect(captured.json()).toMatchObject({ written: [], deleted: [] });
  });

  it('deletes a page for something that no longer exists', async () => {
    const root = await makeRepo();
    await generate(root);
    await fs.writeFile(path.join(root, 'docs/generated/orphan.md'), '# gone\n', 'utf8');

    await runSyncCommand({ cwd: root, json: false, logger: quiet });

    await expect(fs.stat(path.join(root, 'docs/generated/orphan.md'))).rejects.toThrow();
  });

  it('changes nothing on a dry run', async () => {
    const root = await makeRepo();
    await generate(root);
    await fs.appendFile(path.join(root, 'docs/generated/routes.md'), '\nstale\n', 'utf8');
    const before = await fs.readFile(path.join(root, 'docs/generated/routes.md'), 'utf8');

    await runSyncCommand({ cwd: root, dryRun: true, json: false, logger: quiet });

    expect(await fs.readFile(path.join(root, 'docs/generated/routes.md'), 'utf8')).toBe(before);
  });

  it('is idempotent — a second run writes nothing', async () => {
    const root = await makeRepo();
    await runSyncCommand({ cwd: root, json: false, logger: quiet });

    const captured = capture();
    await runSyncCommand({ cwd: root, json: true, logger: captured.logger });

    expect(captured.json()).toMatchObject({ written: [] });
  });

  it('generates from scratch in a repo that has never run extract', async () => {
    const root = await makeRepo();
    await runSyncCommand({ cwd: root, json: false, logger: quiet });

    await expect(fs.stat(path.join(root, 'docs/generated/README.md'))).resolves.toBeDefined();
    await expect(runCheckCommand({ cwd: root, json: false, logger: quiet })).resolves.toBeUndefined();
  });
});
