import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepository } from './helpers/repository.js';
import { runWalkthroughImportCommand, runWalkthroughReviewCommand } from '../src/commands/walkthrough.js';
import { loadWalkthroughs } from '../src/walkthrough/store.js';
import { runCheckCommand } from '../src/commands/check.js';
import { runExtractCommand } from '../src/commands/extract.js';
import { runSyncCommand } from '../src/commands/sync.js';
import { createLogger } from '../src/util/logger.js';
import { docgenConfigSchema } from '../src/config/schema.js';

const roots: string[] = [];
const logger = createLogger({ level: 'silent' });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

async function fixture() {
  const root = await createRepository();
  roots.push(root);
  await fs.mkdir(path.join(root, 'screenshots'));
  await fs.writeFile(path.join(root, 'screenshots/start.png'), PNG);
  const input = {
    schemaVersion: 1, id: 'account-setup', title: 'Set up an account', summary: 'A recorded product walkthrough.',
    steps: [{ title: 'Open settings', instruction: 'Choose Settings from the navigation.', screenshot: 'screenshots/start.png', alt: 'Settings page', expected: 'The settings form is visible.' }],
  };
  await fs.writeFile(path.join(root, 'walkthrough.json'), JSON.stringify(input));
  return { root, input };
}

afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('screenshot walkthrough lifecycle', () => {
  it('imports immutable screenshots, attributes the draft, and generates a linked guide', async () => {
    const { root } = await fixture();
    await runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger });
    const [record] = await loadWalkthroughs(root);
    expect(record).toMatchObject({ id: 'account-setup', recordedBy: 'dev@example.com', status: 'draft' });
    expect(record?.steps[0]?.screenshot.file).toMatch(/^docs\/\.walkthroughs\/assets\/account-setup\/[a-f0-9]{64}\.png$/);
    expect(await fs.readFile(path.join(root, record!.steps[0]!.screenshot.file))).toEqual(PNG);
    const page = await fs.readFile(path.join(root, 'docs/generated/walkthroughs/account-setup.md'), 'utf8');
    expect(page).toContain('<!-- docgen:generated -->');
    expect(page).toContain('Choose Settings from the navigation.');
    expect(page).toContain('![Settings page](../../.walkthroughs/assets/account-setup/');
    expect(page).toContain('not yet reviewed');
    expect(await fs.readFile(path.join(root, 'docs/generated/README.md'), 'utf8')).toContain('(walkthroughs.md)');
    await expect(runCheckCommand({ cwd: root, logger })).resolves.toBeUndefined();
    await runExtractCommand({ cwd: root, json: false, logger });
    expect(await fs.readFile(path.join(root, 'docs/generated/walkthroughs/account-setup.md'), 'utf8')).toBe(page);
    await expect(runCheckCommand({ cwd: root, logger })).resolves.toBeUndefined();
  });

  it('reviews an exact snapshot, preserves review on sync, and resets it on explicit update', async () => {
    const { root, input } = await fixture();
    await runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger });
    await runWalkthroughReviewCommand({ cwd: root, id: input.id, logger });
    const reviewed = (await loadWalkthroughs(root))[0]!;
    expect(reviewed.status).toBe('reviewed');
    expect(reviewed.review).toMatchObject({ reviewedBy: 'dev@example.com', contentHash: reviewed.contentHash });
    await runSyncCommand({ cwd: root, logger });
    expect((await loadWalkthroughs(root))[0]?.review).toEqual(reviewed.review);
    await fs.writeFile(path.join(root, 'walkthrough.json'), JSON.stringify({ ...input, title: 'Updated account setup' }));
    await runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', update: true, logger });
    expect((await loadWalkthroughs(root))[0]).toMatchObject({ title: 'Updated account setup', status: 'draft' });
    expect((await loadWalkthroughs(root))[0]?.review).toBeUndefined();
  });

  it('fails check for screenshot tampering and never silently reapproves it', async () => {
    const { root } = await fixture();
    await runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger });
    await runWalkthroughReviewCommand({ cwd: root, id: 'account-setup', logger });
    const record = (await loadWalkthroughs(root))[0]!;
    await fs.appendFile(path.join(root, record.steps[0]!.screenshot.file), 'tampered');
    await expect(runCheckCommand({ cwd: root, logger })).rejects.toMatchObject({ code: 'walkthrough-image-changed' });
    await expect(runSyncCommand({ cwd: root, logger })).rejects.toMatchObject({ code: 'walkthrough-image-changed' });
    expect(JSON.parse(await fs.readFile(path.join(root, 'docs/.walkthroughs/account-setup.json'), 'utf8')).review).toEqual(record.review);
  });

  it('honors custom output directories and preserves human documents and owned source assets', async () => {
    const { root } = await fixture();
    await fs.writeFile(path.join(root, 'docgen.config.json'), JSON.stringify({ outDir: 'help/product' }));
    await fs.mkdir(path.join(root, 'help/product/walkthroughs'), { recursive: true });
    await fs.writeFile(path.join(root, 'help/product/team-notes.md'), '# Human notes\n');
    await runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger });
    const page = await fs.readFile(path.join(root, 'help/product/walkthroughs/account-setup.md'), 'utf8');
    expect(page).toContain('../../../docs/.walkthroughs/assets/account-setup/');
    const record = (await loadWalkthroughs(root))[0]!;
    await fs.unlink(path.join(root, 'docs/.walkthroughs/account-setup.json'));
    await runSyncCommand({ cwd: root, logger });
    await expect(fs.stat(path.join(root, 'help/product/walkthroughs/account-setup.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(root, 'help/product/team-notes.md'), 'utf8')).toBe('# Human notes\n');
    expect(await fs.readFile(path.join(root, record.steps[0]!.screenshot.file))).toEqual(PNG);
  });

  it('refuses duplicate ids and generated-page collisions without committing a walkthrough record', async () => {
    const { root } = await fixture();
    await fs.mkdir(path.join(root, 'docs/generated/walkthroughs'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs/generated/walkthroughs/account-setup.md'), '# Human guide\n');
    await expect(runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger })).rejects.toMatchObject({ code: 'generated-file-owned' });
    await expect(fs.stat(path.join(root, 'docs/.walkthroughs/account-setup.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.unlink(path.join(root, 'docs/generated/walkthroughs/account-setup.md'));
    await runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger });
    await expect(runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger })).rejects.toMatchObject({ code: 'walkthrough-already-exists' });
  });

  it('does no writes on an import preview', async () => {
    const { root } = await fixture();
    await runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', dryRun: true, logger });
    await expect(fs.stat(path.join(root, 'docs/.walkthroughs'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(root, 'docs/generated'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('repairs a missing old screenshot through an explicit unreviewed update', async () => {
    const { root } = await fixture();
    await runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger });
    await runWalkthroughReviewCommand({ cwd: root, id: 'account-setup', logger });
    const record = (await loadWalkthroughs(root))[0]!;
    await fs.unlink(path.join(root, record.steps[0]!.screenshot.file));
    await runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', update: true, logger });
    expect((await loadWalkthroughs(root))[0]?.status).toBe('draft');
    expect((await loadWalkthroughs(root))[0]?.review).toBeUndefined();
  });

  it('reports malformed page URLs as input validation errors', async () => {
    const { root, input } = await fixture();
    await fs.writeFile(path.join(root, 'walkthrough.json'), JSON.stringify({ ...input, steps: [{ ...input.steps[0], url: 'not-a-url' }] }));
    await expect(runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger })).rejects.toMatchObject({ code: 'walkthrough-input-invalid' });
    await expect(fs.stat(path.join(root, 'docs/.walkthroughs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('canonicalizes page URLs so delimiters cannot inject HTML or persist query secrets', async () => {
    const { root, input } = await fixture();
    const url = 'https://example.test/> <img src=x onerror=alert(1)>?token=secret#fragment';
    await fs.writeFile(path.join(root, 'walkthrough.json'), JSON.stringify({ ...input, steps: [{ ...input.steps[0], url }] }));
    await runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger });
    const page = await fs.readFile(path.join(root, 'docs/generated/walkthroughs/account-setup.md'), 'utf8');
    expect(page).not.toContain('<img');
    expect(page).not.toContain('token=secret');
    expect((await loadWalkthroughs(root))[0]?.steps[0]?.url).toContain('%3Cimg');
  });

  it('cleans partial image writes and permits a clean retry without committing a broken record', async () => {
    const { root } = await fixture();
    const write = fs.writeFile.bind(fs);
    const failure = Object.assign(new Error('image write failed'), { code: 'EACCES' });
    let failed = false;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      if (!failed && String(file).includes('.png.docgen-tmp-')) {
        failed = true;
        await write(file, Buffer.from([0]), options);
        throw failure;
      }
      await write(file, data, options);
    });
    await expect(runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger })).rejects.toBe(failure);
    expect(await fs.readdir(path.join(root, 'docs/.walkthroughs/assets/account-setup'))).toEqual([]);
    await expect(fs.stat(path.join(root, 'docs/.walkthroughs/account-setup.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    vi.restoreAllMocks();
    await runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger });
    expect(await loadWalkthroughs(root)).toHaveLength(1);
  });

  it('refuses a concurrent asset winner whose bytes do not match the recorded hash', async () => {
    const { root } = await fixture();
    const link = fs.link.bind(fs);
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      if (String(to).endsWith('.png')) await fs.writeFile(to, 'different winning bytes');
      await link(from, to);
    });
    await expect(runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger })).rejects.toMatchObject({ code: 'walkthrough-image-changed' });
    await expect(fs.stat(path.join(root, 'docs/.walkthroughs/account-setup.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores the exact content-addressed image on an explicit update after corruption', async () => {
    const { root } = await fixture();
    await runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger });
    const record = (await loadWalkthroughs(root))[0]!;
    await fs.writeFile(path.join(root, record.steps[0]!.screenshot.file), 'corrupted bytes');
    await runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', update: true, logger });
    expect(await fs.readFile(path.join(root, record.steps[0]!.screenshot.file))).toEqual(PNG);
    expect((await loadWalkthroughs(root))[0]?.status).toBe('draft');
  });
});

describe('walkthrough input safety', () => {
  it.each(['../outside.png', '/outside.png', 'C:/outside.png', 'https://example.test/image.png'])('rejects unsafe screenshot paths %s', async (screenshot) => {
    const { root, input } = await fixture();
    await fs.writeFile(path.join(root, 'walkthrough.json'), JSON.stringify({ ...input, steps: [{ ...input.steps[0], screenshot }] }));
    await expect(runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger })).rejects.toMatchObject({ code: 'walkthrough-input-invalid' });
  });

  it.each(['photo.svg', 'fake.png'])('rejects non-image or active content %s', async (screenshot) => {
    const { root, input } = await fixture();
    await fs.writeFile(path.join(root, screenshot), '<script>bad()</script>');
    await fs.writeFile(path.join(root, 'walkthrough.json'), JSON.stringify({ ...input, steps: [{ ...input.steps[0], screenshot }] }));
    await expect(runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger })).rejects.toMatchObject({ code: 'walkthrough-image-invalid' });
  });

  it('rejects linked screenshot sources and protects the walkthrough store as an output directory', async () => {
    const { root, input } = await fixture();
    await fs.symlink(path.join(root, 'screenshots'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(path.join(root, 'walkthrough.json'), JSON.stringify({ ...input, steps: [{ ...input.steps[0], screenshot: 'linked/start.png' }] }));
    await expect(runWalkthroughImportCommand({ cwd: root, file: 'walkthrough.json', logger })).rejects.toMatchObject({ code: 'generated-path-symlink' });
    expect(docgenConfigSchema.safeParse({ outDir: 'docs/.walkthroughs' }).success).toBe(false);
  });
});
