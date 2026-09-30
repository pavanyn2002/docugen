import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WALKTHROUGHS_DIR } from '../config/paths.js';
import { writeFileAtomically } from '../util/atomic.js';
import { DocgenError, validationMessages } from '../util/errors.js';
import { assertGeneratedPath } from '../util/generated.js';
import { compareStrings } from '../util/sort.js';
import { MAX_SCREENSHOT_BYTES, relativeFileSchema, walkthroughInputSchema, walkthroughRecordSchema } from './schema.js';
import type { WalkthroughInput, WalkthroughRecord } from './schema.js';

export function screenshotHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function walkthroughContentHash(record: Pick<WalkthroughRecord, 'id' | 'title' | 'summary' | 'steps'>): string {
  return screenshotHash(Buffer.from(JSON.stringify({ id: record.id, title: record.title, summary: record.summary ?? null, steps: record.steps })));
}

function failure(code: string, message: string, file?: string): DocgenError {
  return new DocgenError({ code, message, remedy: 'Correct the walkthrough or image, then explicitly import the corrected snapshot and review it again.', ...(file === undefined ? {} : { file }) });
}

function imageType(bytes: Buffer, file: string): { mediaType: WalkthroughRecord['steps'][number]['screenshot']['mediaType']; extension: string } {
  if (bytes.length === 0 || bytes.length > MAX_SCREENSHOT_BYTES) throw failure('walkthrough-image-invalid', 'Screenshots must be nonempty and no larger than 15 MiB.', file);
  const extension = path.posix.extname(file).toLowerCase();
  if (extension === '.png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return { mediaType: 'image/png', extension: 'png' };
  if (['.jpg', '.jpeg'].includes(extension) && bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return { mediaType: 'image/jpeg', extension: 'jpg' };
  if (extension === '.webp' && bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mediaType: 'image/webp', extension: 'webp' };
  throw failure('walkthrough-image-invalid', 'The screenshot must be a PNG, JPEG, or WebP image matching its extension.', file);
}

export async function readWalkthroughInput(root: string, file: string): Promise<{ input: WalkthroughInput; directory: string }> {
  if (!relativeFileSchema.safeParse(file).success) throw failure('walkthrough-input-invalid', 'The manifest must use a repository-relative path.', file);
  await assertGeneratedPath(root, file);
  let raw: unknown;
  try { raw = JSON.parse(await fs.readFile(path.join(root, file), 'utf8')); }
  catch (cause) { throw new DocgenError({ code: 'walkthrough-input-invalid', message: `Cannot read walkthrough manifest '${file}'.`, remedy: 'Provide a readable JSON walkthrough manifest.', file, cause }); }
  const parsed = walkthroughInputSchema.safeParse(raw);
  if (!parsed.success) throw failure('walkthrough-input-invalid', validationMessages(parsed.error.issues), file);
  return { input: parsed.data, directory: path.posix.dirname(file) };
}

export async function prepareWalkthrough(args: {
  root: string; input: WalkthroughInput; directory?: string; images?: ReadonlyMap<string, Buffer>;
  source: 'import' | 'capture'; recordedBy: string; recordedAt?: string;
}): Promise<{ record: WalkthroughRecord; assets: ReadonlyMap<string, Buffer> }> {
  const input = walkthroughInputSchema.parse(args.input);
  const assets = new Map<string, Buffer>();
  const steps: WalkthroughRecord['steps'] = [];
  for (const step of input.steps) {
    let bytes = args.images?.get(step.screenshot);
    if (args.images !== undefined && bytes === undefined) throw failure('walkthrough-image-missing', 'The captured screenshot is missing.', step.screenshot);
    if (bytes === undefined) {
      const file = path.posix.join(args.directory ?? '.', step.screenshot);
      await assertGeneratedPath(args.root, file);
      try {
        const stat = await fs.stat(path.join(args.root, file));
        if (!stat.isFile() || stat.size > MAX_SCREENSHOT_BYTES) throw failure('walkthrough-image-invalid', 'Screenshot is not an ordinary image within the size limit.', file);
        bytes = await fs.readFile(path.join(args.root, file));
      } catch (cause) {
        if (cause instanceof DocgenError) throw cause;
        throw new DocgenError({ code: 'walkthrough-image-missing', message: `Cannot read screenshot '${file}'.`, remedy: 'Provide every screenshot before importing the guide.', file, cause });
      }
    }
    const type = imageType(bytes, step.screenshot);
    const sha256 = screenshotHash(bytes);
    const file = `${WALKTHROUGHS_DIR}/assets/${input.id}/${sha256}.${type.extension}`;
    const { screenshot: _source, ...details } = step;
    steps.push({ ...details, screenshot: { file, sha256, mediaType: type.mediaType, bytes: bytes.length } });
    assets.set(file, bytes);
  }
  const record: WalkthroughRecord = {
    schemaVersion: 1, id: input.id, title: input.title,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    source: args.source, recordedBy: args.recordedBy, recordedAt: args.recordedAt ?? new Date().toISOString(),
    status: 'draft', contentHash: '', steps,
  };
  return { record: walkthroughRecordSchema.parse({ ...record, contentHash: walkthroughContentHash(record) }), assets };
}

export async function loadWalkthroughs(root: string, options: { readonly replacingId?: string } = {}): Promise<readonly WalkthroughRecord[]> {
  await assertGeneratedPath(root, WALKTHROUGHS_DIR);
  let names: string[];
  try { names = await fs.readdir(path.join(root, WALKTHROUGHS_DIR)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const records: WalkthroughRecord[] = [];
  for (const name of names.filter((name) => name.endsWith('.json')).sort(compareStrings)) {
    const file = `${WALKTHROUGHS_DIR}/${name}`;
    await assertGeneratedPath(root, file);
    let raw: unknown;
    try { raw = JSON.parse(await fs.readFile(path.join(root, file), 'utf8')); }
    catch (cause) { throw new DocgenError({ code: 'walkthrough-record-invalid', message: `Cannot read '${file}'.`, remedy: 'Repair this human-owned walkthrough record; it is never silently skipped.', file, cause }); }
    const parsed = walkthroughRecordSchema.safeParse(raw);
    if (!parsed.success) throw failure('walkthrough-record-invalid', validationMessages(parsed.error.issues), file);
    const record = parsed.data;
    if (name !== `${record.id}.json` || record.contentHash !== walkthroughContentHash(record)) throw failure('walkthrough-record-changed', 'The walkthrough snapshot or identity has changed without an explicit import.', file);
    for (const step of record.steps) {
      const image = step.screenshot;
      const extension = image.mediaType === 'image/png' ? 'png' : image.mediaType === 'image/jpeg' ? 'jpg' : 'webp';
      if (image.file !== `${WALKTHROUGHS_DIR}/assets/${record.id}/${image.sha256}.${extension}`) throw failure('walkthrough-record-invalid', 'Screenshot references must use their content-addressed walkthrough asset paths.', file);
      if (options.replacingId === record.id) continue;
      await assertGeneratedPath(root, image.file);
      let bytes: Buffer;
      try { bytes = await fs.readFile(path.join(root, image.file)); }
      catch (cause) { throw new DocgenError({ code: 'walkthrough-image-missing', message: `Missing walkthrough screenshot '${image.file}'.`, remedy: 'Restore the recorded image or explicitly import an updated snapshot.', file: image.file, cause }); }
      if (bytes.length !== image.bytes || screenshotHash(bytes) !== image.sha256) throw failure('walkthrough-image-changed', 'The walkthrough screenshot differs from its recorded hash.', image.file);
      imageType(bytes, image.file);
    }
    records.push(record);
  }
  return records.sort((a, b) => compareStrings(a.id, b.id));
}

export async function saveWalkthrough(root: string, prepared: { record: WalkthroughRecord; assets: ReadonlyMap<string, Buffer> }, update = false): Promise<string> {
  const record = walkthroughRecordSchema.parse(prepared.record);
  const file = `${WALKTHROUGHS_DIR}/${record.id}.json`;
  for (const step of record.steps) {
    const image = step.screenshot;
    const extension = image.mediaType === 'image/png' ? 'png' : image.mediaType === 'image/jpeg' ? 'jpg' : 'webp';
    if (image.file !== `${WALKTHROUGHS_DIR}/assets/${record.id}/${image.sha256}.${extension}`) throw failure('walkthrough-record-invalid', 'Prepared screenshots must use their content-addressed asset paths.', file);
  }
  await assertGeneratedPath(root, file);
  const existing = (await loadWalkthroughs(root, update ? { replacingId: record.id } : {})).find((item) => item.id === record.id);
  if (existing !== undefined && !update) throw failure('walkthrough-already-exists', `Walkthrough '${record.id}' already exists. Use --update to record a new unreviewed snapshot.`, file);
  if (existing === undefined && update) throw failure('walkthrough-not-found', `Walkthrough '${record.id}' does not exist. Import it without --update.`, file);
  const expectedAssets = new Map(record.steps.map((step) => [step.screenshot.file, step.screenshot]));
  if (record.contentHash !== walkthroughContentHash(record) || prepared.assets.size !== expectedAssets.size) throw failure('walkthrough-record-invalid', 'Prepared screenshot assets must match the recorded walkthrough snapshot.', file);
  const repairs = new Set<string>();
  const oldAssets = new Set(existing?.steps.map((step) => step.screenshot.file) ?? []);
  for (const [asset, bytes] of prepared.assets) {
    const expected = expectedAssets.get(asset);
    if (expected === undefined || bytes.length !== expected.bytes || screenshotHash(bytes) !== expected.sha256) throw failure('walkthrough-image-invalid', 'Prepared image bytes must match the recorded screenshot.', asset);
    if (imageType(bytes, asset).mediaType !== expected.mediaType) throw failure('walkthrough-image-invalid', 'Screenshot format does not match the recorded media type.', asset);
    await assertGeneratedPath(root, asset);
    let previous: Buffer | undefined;
    try { previous = await fs.readFile(path.join(root, asset)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous !== undefined && !previous.equals(bytes)) {
      if (update && oldAssets.has(asset)) repairs.add(asset);
      else throw failure('walkthrough-image-changed', 'Refusing to overwrite a different screenshot at an immutable asset path.', asset);
    }
  }
  for (const [asset, bytes] of prepared.assets) {
    const target = path.join(root, asset);
    try { await writeFileAtomically(target, bytes, { createOnly: !repairs.has(asset) }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const winner = await fs.readFile(target);
      if (!winner.equals(bytes)) throw failure('walkthrough-image-changed', 'A concurrent import published different screenshot bytes.', asset);
    }
  }
  await writeFileAtomically(path.join(root, file), `${JSON.stringify(record, null, 2)}\n`, { createOnly: !update });
  return file;
}

export async function reviewWalkthrough(root: string, id: string, reviewedBy: string): Promise<WalkthroughRecord> {
  if (reviewedBy.trim().length === 0 || reviewedBy === 'unknown') throw failure('walkthrough-review-identity-required', 'Review requires an explicit Git identity.');
  const record = (await loadWalkthroughs(root)).find((item) => item.id === id);
  if (record === undefined) throw failure('walkthrough-not-found', `Walkthrough '${id}' does not exist.`);
  const reviewed = walkthroughRecordSchema.parse({ ...record, status: 'reviewed', review: { reviewedBy, reviewedAt: new Date().toISOString(), contentHash: record.contentHash } });
  await writeFileAtomically(path.join(root, `${WALKTHROUGHS_DIR}/${id}.json`), `${JSON.stringify(reviewed, null, 2)}\n`);
  return reviewed;
}
