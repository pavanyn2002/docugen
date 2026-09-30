import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureWalkthroughFlow, readCaptureFlow } from '../src/walkthrough/capture.js';

const browserMock = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('node:module', () => ({ createRequire: () => browserMock.load }));

let root: string;
const base = { schemaVersion: 1, id: 'login', title: 'Sign in', startUrl: 'http://localhost:3000', steps: [{ title: 'Open', instruction: 'Open the page' }] };
async function flow(value: unknown = base): Promise<void> { await fs.writeFile(path.join(root, 'flow.json'), JSON.stringify(value)); }
function browser() {
  const locator = { click: vi.fn().mockResolvedValue(undefined), fill: vi.fn().mockResolvedValue(undefined), waitFor: vi.fn().mockResolvedValue(undefined) };
  const page = { goto: vi.fn().mockResolvedValue(undefined), locator: vi.fn().mockReturnValue(locator), url: vi.fn().mockReturnValue('https://user:password@example.com/path?token=secret#secret'), screenshot: vi.fn().mockResolvedValue(Buffer.from('png')) };
  const context = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined), setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn() };
  const instance = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
  browserMock.load.mockReturnValue({ chromium: { launch: vi.fn().mockResolvedValue(instance) } });
  return { locator, page, context, instance };
}
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-capture-')); browserMock.load.mockReset(); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('capture flow validation', () => {
  it('reads a strict bounded declarative flow', async () => { await flow(); expect(await readCaptureFlow(root, 'flow.json')).toMatchObject(base); });
  it.each([
    { ...base, script: 'arbitrary' }, { ...base, startUrl: 'file:///etc/passwd' }, { ...base, steps: [] },
    { ...base, viewport: { width: 100000, height: 600 } },
    { ...base, steps: [{ title: 'Fill', instruction: 'Fill', actions: [{ type: 'fill', selector: '#secret', value: 'secret', valueEnv: 'SECRET' }] }] },
    { ...base, steps: [{ title: 'Run', instruction: 'Run', actions: [{ type: 'evaluate', code: 'alert(1)' }] }] },
  ])('rejects invalid or executable flows without echoing inputs', async (value) => { await flow(value); await expect(readCaptureFlow(root, 'flow.json')).rejects.toMatchObject({ code: 'walkthrough-flow-invalid' }); });
  it.each(['../flow.json', '/flow.json', 'C:\\flow.json', '..\\flow.json', 'flow.json:stream', 'flow.json ', ' flow.json'])('rejects unsafe path %s', async (file) => { await expect(readCaptureFlow(root, file)).rejects.toThrow(); });
  it('rejects malformed JSON with a useful error', async () => { await fs.writeFile(path.join(root, 'flow.json'), '{'); await expect(readCaptureFlow(root, 'flow.json')).rejects.toMatchObject({ code: 'walkthrough-flow-invalid' }); });
  it.each([{ ...base, title: 'a'.repeat(201) }, { ...base, title: 'First\nsecond' }, { ...base, steps: Array.from({ length: 51 }, () => base.steps[0]) }, { ...base, steps: [{ title: 'Valid', instruction: 'Valid', alt: 'First\nsecond' }] }])('rejects metadata that the importer cannot accept before browser launch', async (value) => {
    await flow(value); await expect(captureWalkthroughFlow({ root, file: 'flow.json' })).rejects.toMatchObject({ code: 'walkthrough-flow-invalid' }); expect(browserMock.load).not.toHaveBeenCalled();
  });
});

describe('browser capture', () => {
  it('captures ordered images, masks secrets, strips URL credentials, and closes resources', async () => {
    const mocks = browser(); vi.stubEnv('DOCGEN_CAPTURE_SECRET', 'do-not-record');
    await flow({ ...base, maskSelectors: ['.private'], steps: [{ title: 'Login', instruction: 'Sign in', expected: 'Dashboard', actions: [{ type: 'fill', selector: '#password', valueEnv: 'DOCGEN_CAPTURE_SECRET' }, { type: 'click', selector: '#submit' }, { type: 'wait', selector: '#dashboard' }, { type: 'goto', url: 'https://example.com/dashboard' }] }] });
    const result = await captureWalkthroughFlow({ root, file: 'flow.json' });
    expect(result.input.steps[0]).toMatchObject({ screenshot: 'step-01.png', alt: 'Login', url: 'https://example.com/path', expected: 'Dashboard' });
    expect(result.images.get('step-01.png')).toEqual(Buffer.from('png'));
    expect(JSON.stringify(result.input)).not.toContain('do-not-record');
    expect(mocks.locator.fill).toHaveBeenCalledWith('do-not-record');
    expect(mocks.page.locator).toHaveBeenCalledWith('input[type="password"]');
    expect(mocks.page.locator).toHaveBeenCalledWith('.private');
    expect(mocks.page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png', fullPage: false, animations: 'disabled' }));
    expect(mocks.context.close).toHaveBeenCalledOnce(); expect(mocks.instance.close).toHaveBeenCalledOnce();
  });
  it('redacts action errors and closes both resources', async () => {
    const mocks = browser(); mocks.locator.click.mockRejectedValue(new Error('call log contains password=SECRET'));
    await flow({ ...base, steps: [{ title: 'Click', instruction: 'Click', actions: [{ type: 'click', selector: '#submit' }] }] });
    await expect(captureWalkthroughFlow({ root, file: 'flow.json' })).rejects.toMatchObject({ code: 'walkthrough-capture-failed', message: expect.not.stringContaining('SECRET') });
    expect(mocks.context.close).toHaveBeenCalledOnce(); expect(mocks.instance.close).toHaveBeenCalledOnce();
  });
  it('closes the browser if creating a context fails', async () => {
    const mocks = browser(); mocks.instance.newContext.mockRejectedValue(new Error('SECRET')); await flow();
    await expect(captureWalkthroughFlow({ root, file: 'flow.json' })).rejects.toThrow(); expect(mocks.instance.close).toHaveBeenCalledOnce();
  });
  it('fails before browser actions if an environment value is absent', async () => {
    const mocks = browser(); vi.stubEnv('DOCGEN_CAPTURE_SECRET', undefined);
    await flow({ ...base, steps: [{ title: 'Fill', instruction: 'Fill', actions: [{ type: 'fill', selector: '#password', valueEnv: 'DOCGEN_CAPTURE_SECRET' }] }] });
    await expect(captureWalkthroughFlow({ root, file: 'flow.json' })).rejects.toThrow(); expect(mocks.page.goto).not.toHaveBeenCalled();
  });
  it('gives install instructions when Playwright is unavailable', async () => {
    browserMock.load.mockImplementation(() => { throw new Error('missing'); }); await flow();
    await expect(captureWalkthroughFlow({ root, file: 'flow.json' })).rejects.toMatchObject({ code: 'walkthrough-browser-missing', remedy: expect.stringContaining('playwright') });
  });
  it('passes authentication state only to the ephemeral browser context', async () => {
    const mocks = browser(); await flow(); await fs.writeFile(path.join(root, 'auth.json'), '{"cookies":[]}');
    const result = await captureWalkthroughFlow({ root, file: 'flow.json', storageState: 'auth.json' });
    expect(mocks.instance.newContext).toHaveBeenCalledWith({ viewport: { width: 1280, height: 720 }, storageState: path.join(root, 'auth.json') });
    expect(JSON.stringify(result.input)).not.toContain('auth.json');
  });
  it('masks environment-filled text inputs on every screenshot without persisting selectors or secrets', async () => {
    const mocks = browser(); const keyLocator = { ...mocks.locator }; mocks.page.locator.mockImplementation((selector: string) => selector === '#api-key' ? keyLocator : mocks.locator);
    vi.stubEnv('DOCGEN_CAPTURE_API_KEY', 'private-api-key');
    await flow({ ...base, steps: [{ title: 'Before', instruction: 'Open settings' }, { title: 'Enter key', instruction: 'Configure the key', actions: [{ type: 'fill', selector: '#api-key', valueEnv: 'DOCGEN_CAPTURE_API_KEY' }] }] });
    const result = await captureWalkthroughFlow({ root, file: 'flow.json' });
    expect(mocks.page.screenshot).toHaveBeenCalledTimes(2);
    for (const [options] of mocks.page.screenshot.mock.calls) expect((options as { mask: unknown[] }).mask).toContain(keyLocator);
    expect(JSON.stringify(result.input)).not.toMatch(/private-api-key|#api-key|DOCGEN_CAPTURE_API_KEY/);
  });
  it('closes the browser even if context cleanup fails', async () => {
    const mocks = browser(); mocks.context.close.mockRejectedValue(new Error('SECRET')); await flow();
    await expect(captureWalkthroughFlow({ root, file: 'flow.json' })).rejects.toMatchObject({ code: 'walkthrough-browser-close-failed', message: expect.not.stringContaining('SECRET') });
    expect(mocks.instance.close).toHaveBeenCalledOnce();
  });
  it('preserves the redacted capture error when cleanup also fails', async () => {
    const mocks = browser(); mocks.page.screenshot.mockRejectedValue(new Error('SECRET')); mocks.context.close.mockRejectedValue(new Error('SECRET')); await flow();
    await expect(captureWalkthroughFlow({ root, file: 'flow.json' })).rejects.toMatchObject({ code: 'walkthrough-capture-failed' });
    expect(mocks.instance.close).toHaveBeenCalledOnce();
  });
  it('gives browser install instructions for launch failures', async () => {
    browserMock.load.mockReturnValue({ chromium: { launch: vi.fn().mockRejectedValue(new Error('SECRET')) } }); await flow();
    await expect(captureWalkthroughFlow({ root, file: 'flow.json' })).rejects.toMatchObject({ code: 'walkthrough-browser-launch-failed', remedy: expect.stringContaining('playwright install chromium') });
  });
  it('captures successive states in the supplied order with explicit alt text', async () => {
    const mocks = browser(); mocks.page.url.mockReturnValue('about:blank');
    await flow({ ...base, viewport: { width: 640, height: 480 }, steps: [{ title: 'First', instruction: 'First', alt: 'Custom alt' }, { title: 'Second', instruction: 'Second', fullPage: true }] });
    const result = await captureWalkthroughFlow({ root, file: 'flow.json', headed: true, channel: 'msedge' });
    expect([...result.images.keys()]).toEqual(['step-01.png', 'step-02.png']);
    expect(result.input.steps[0]).toMatchObject({ alt: 'Custom alt' }); expect(result.input.steps[0]).not.toHaveProperty('url');
    expect(mocks.page.screenshot).toHaveBeenLastCalledWith(expect.objectContaining({ fullPage: true }));
    expect(mocks.instance.newContext).toHaveBeenCalledWith({ viewport: { width: 640, height: 480 } });
  });
});
