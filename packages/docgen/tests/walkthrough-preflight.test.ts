import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepository } from './helpers/repository.js';
import { runWalkthroughCaptureCommand } from '../src/commands/walkthrough.js';
import * as capture from '../src/walkthrough/capture.js';
import { createLogger } from '../src/util/logger.js';

const roots: string[] = [];
const logger = createLogger({ level: 'silent' });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await createRepository(); roots.push(root);
  await fs.writeFile(path.join(root, 'flow.json'), JSON.stringify({ schemaVersion: 1, id: 'setup', title: 'Setup', startUrl: 'http://127.0.0.1:3000', steps: [{ title: 'Submit', instruction: 'Choose Submit', actions: [{ type: 'click', selector: '#submit' }] }] }));
  const start = vi.spyOn(capture, 'captureWalkthroughFlow').mockRejectedValue(new Error('Browser should not start'));
  return { root, start };
}

describe('browser flow preflight', () => {
  it.each([false, true])('rejects updates to missing guides before any browser side effects (preview=%s)', async (dryRun) => {
    const { root, start } = await fixture();
    await expect(runWalkthroughCaptureCommand({ cwd: root, file: 'flow.json', update: true, dryRun, logger })).rejects.toMatchObject({ code: 'walkthrough-not-found' });
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects collisions in other generated output before opening the browser', async () => {
    const { root, start } = await fixture();
    await fs.mkdir(path.join(root, 'docs/generated'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs/generated/README.md'), '# Human index');
    await expect(runWalkthroughCaptureCommand({ cwd: root, file: 'flow.json', logger })).rejects.toMatchObject({ code: 'generated-file-owned' });
    expect(start).not.toHaveBeenCalled();
  });

  it('validates a complete preview without importing Playwright or writing files', async () => {
    const { root, start } = await fixture();
    await runWalkthroughCaptureCommand({ cwd: root, file: 'flow.json', dryRun: true, logger });
    expect(start).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, 'docs/.walkthroughs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
