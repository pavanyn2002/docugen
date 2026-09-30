import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { assertGeneratedPath } from '../util/generated.js';
import { DocgenError } from '../util/errors.js';
import type { WalkthroughInput } from './schema.js';

const text = z.string().trim().min(1).max(4000);
const heading = z.string().trim().min(1).max(200).refine((value) => !/[\r\n]/.test(value), 'Use a single line.');
const selector = z.string().min(1).max(1000);
const webUrl = z.string().max(4000).refine((value) => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}, 'Use an absolute HTTP or HTTPS URL.');
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('goto'), url: webUrl }).strict(),
  z.object({ type: z.literal('click'), selector }).strict(),
  z.object({ type: z.literal('wait'), selector }).strict(),
  z.object({ type: z.literal('fill'), selector, value: z.string().max(10000).optional(), valueEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200).optional() }).strict(),
]).superRefine((action, context) => {
  if (action.type === 'fill' && ((action.value === undefined) === (action.valueEnv === undefined))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Fill requires exactly one of value and valueEnv.' });
  }
});
export const captureFlowSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80), title: heading,
  summary: text.optional(), startUrl: webUrl,
  viewport: z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(240).max(2160) }).strict().optional(),
  maskSelectors: z.array(selector).max(50).optional(),
  steps: z.array(z.object({ title: heading, instruction: text, alt: heading.optional(), expected: text.optional(), fullPage: z.boolean().optional(), actions: z.array(actionSchema).max(50).optional() }).strict()).min(1).max(50),
}).strict();
export type CaptureFlow = z.output<typeof captureFlowSchema>;

function fail(code: string, message: string, remedy: string): DocgenError { return new DocgenError({ code, message, remedy }); }

function relativeFile(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized.trim() !== normalized || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value) || normalized.split('/').includes('..') || /[\u0000-\u001f\u007f:<>|"*?]/.test(value) || normalized.split('/').some((segment) => segment !== '.' && /[. ]$/.test(segment))) {
    throw fail('walkthrough-flow-path-invalid', 'Capture files must use repository-relative paths.', 'Place the flow and authentication state inside the target repository, outside symbolic links.');
  }
  return normalized;
}

/** Capture flows are declarative trusted user input; never execute embedded code. */
export async function readCaptureFlow(root: string, file: string): Promise<CaptureFlow> {
  const relative = relativeFile(file);
  await assertGeneratedPath(root, relative);
  const target = path.join(root, relative);
  const stat = await fs.stat(target).catch(() => { throw fail('walkthrough-flow-unreadable', 'Could not read the capture flow.', 'Check that the flow file exists and is readable.'); });
  if (!stat.isFile() || stat.size > 1024 * 1024) throw fail('walkthrough-flow-invalid', 'Capture flow must be a JSON file of at most 1 MiB.', 'Use a bounded JSON capture flow with at most 50 steps.');
  let input: unknown;
  try { input = JSON.parse(await fs.readFile(target, 'utf8')); }
  catch { throw fail('walkthrough-flow-invalid', 'Capture flow contains unreadable or malformed JSON.', 'Correct the JSON syntax in the flow file.'); }
  const parsed = captureFlowSchema.safeParse(input);
  if (!parsed.success) throw fail('walkthrough-flow-invalid', 'Capture flow does not match the supported schema.', 'Use schemaVersion 1, an id, title, HTTP(S) startUrl, and 1–50 steps. Titles and alt text must be a single line of at most 200 characters. Actions support only goto, click, fill, and wait; fill requires exactly one of value and valueEnv.');
  return parsed.data;
}

// A small runtime boundary avoids loading an optional browser dependency in static commands.
interface Locator { click(): Promise<unknown>; fill(value: string): Promise<unknown>; waitFor(options: { state: 'visible' }): Promise<unknown> }
interface Page { goto(url: string, options: { waitUntil: 'domcontentloaded' }): Promise<unknown>; locator(selector: string): Locator; url(): string; screenshot(options: { type: 'png'; fullPage: boolean; animations: 'disabled'; mask: Locator[]; maskColor: string; timeout: number }): Promise<Buffer> }
interface Context { newPage(): Promise<Page>; close(): Promise<unknown>; setDefaultTimeout(timeout: number): void; setDefaultNavigationTimeout(timeout: number): void }
interface Browser { newContext(options: { viewport: { width: number; height: number }; storageState?: string }): Promise<Context>; close(): Promise<unknown> }
interface BrowserLibrary { chromium: { launch(options: { headless: boolean; channel?: 'chrome' | 'msedge' }): Promise<Browser> } }

function loadBrowser(root: string): BrowserLibrary {
  for (const require of [createRequire(path.join(path.resolve(root), 'package.json')), createRequire(import.meta.url)]) {
    try {
      const library = require('playwright') as BrowserLibrary;
      if (typeof library.chromium?.launch === 'function') return library;
    } catch { /* Try the target repository, then Docugen's optional peer. */ }
  }
  throw fail('walkthrough-browser-missing', 'Browser capture requires Playwright.', 'Install it in the target repository: npm install --save-dev playwright; then run npx playwright install chromium. Screenshot import does not require Playwright.');
}

function publicUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString();
  } catch { return undefined; }
}

export interface CaptureOptions { root: string; file: string; channel?: 'chrome' | 'msedge'; headed?: boolean; storageState?: string }

/** Return images in memory; the walkthrough importer owns all persistent writes. */
export async function captureWalkthroughFlow(options: CaptureOptions): Promise<{ input: WalkthroughInput; images: ReadonlyMap<string, Buffer> }> {
  const flow = await readCaptureFlow(options.root, options.file);
  // Resolve secrets before navigating so a missing value cannot leave a partial flow.
  const fillValues = new Map<object, string>();
  const secretSelectors = new Set<string>();
  for (const step of flow.steps) for (const action of step.actions ?? []) {
    if (action.type !== 'fill') continue;
    const value = action.valueEnv === undefined ? action.value : process.env[action.valueEnv];
    if (value === undefined) throw fail('walkthrough-capture-env-missing', 'A required capture environment value is missing.', 'Set every environment variable named by a fill action before capturing.');
    fillValues.set(action, value);
    if (action.valueEnv !== undefined) secretSelectors.add(action.selector);
  }
  let storageState: string | undefined;
  if (options.storageState !== undefined) {
    const relative = relativeFile(options.storageState);
    await assertGeneratedPath(options.root, relative);
    storageState = path.join(options.root, relative);
  }
  const library = loadBrowser(options.root);
  let browser: Browser;
  try { browser = await library.chromium.launch({ headless: !options.headed, ...(options.channel === undefined ? {} : { channel: options.channel }) }); }
  catch { throw fail('walkthrough-browser-launch-failed', 'Could not launch the capture browser.', 'Run npx playwright install chromium, or install Chrome/Edge and select that browser channel.'); }
  let context: Context | undefined;
  let primaryError: unknown;
  try {
    context = await browser.newContext({ viewport: flow.viewport ?? { width: 1280, height: 720 }, ...(storageState === undefined ? {} : { storageState }) });
    context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(30000);
    const page = await context.newPage();
    await page.goto(flow.startUrl, { waitUntil: 'domcontentloaded' });
    const images = new Map<string, Buffer>();
    const steps: WalkthroughInput['steps'] = [];
    for (const [index, step] of flow.steps.entries()) {
      for (const action of step.actions ?? []) {
        switch (action.type) {
          case 'goto': await page.goto(action.url, { waitUntil: 'domcontentloaded' }); break;
          case 'click': await page.locator(action.selector).click(); break;
          case 'fill': await page.locator(action.selector).fill(fillValues.get(action)!); break;
          case 'wait': await page.locator(action.selector).waitFor({ state: 'visible' }); break;
        }
      }
      const screenshot = `step-${String(index + 1).padStart(2, '0')}.png`;
      const masks = new Set(['input[type="password"]', ...(flow.maskSelectors ?? []), ...secretSelectors]);
      images.set(screenshot, await page.screenshot({ type: 'png', fullPage: step.fullPage ?? false, animations: 'disabled', mask: [...masks].map((value) => page.locator(value)), maskColor: '#e5e7eb', timeout: 30000 }));
      const url = publicUrl(page.url());
      steps.push({ title: step.title, instruction: step.instruction, alt: step.alt ?? step.title, screenshot, ...(step.expected === undefined ? {} : { expected: step.expected }), ...(url === undefined ? {} : { url }) });
    }
    return { input: { schemaVersion: 1, id: flow.id, title: flow.title, ...(flow.summary === undefined ? {} : { summary: flow.summary }), steps }, images };
  } catch {
    primaryError = fail('walkthrough-capture-failed', 'Browser capture failed while executing the flow.', 'Check the flow URLs and selectors, the application state, and supplied authentication state. Browser details are omitted to protect fill values and credentials.');
    throw primaryError;
  } finally {
    let closeFailed = false;
    if (context !== undefined) { try { await context.close(); } catch { closeFailed = true; } }
    try { await browser.close(); } catch { closeFailed = true; }
    if (closeFailed && primaryError === undefined) throw fail('walkthrough-browser-close-failed', 'The capture browser could not be closed cleanly.', 'Close the remaining browser process and retry the capture.');
  }
}
