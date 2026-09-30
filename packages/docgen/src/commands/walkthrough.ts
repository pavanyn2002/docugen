import { loadConfig } from '../config/load.js';
import { WALKTHROUGHS_DIR } from '../config/paths.js';
import { runExtraction } from '../pipeline.js';
import { assertGeneratedTargets } from '../util/generated.js';
import { resolveGitUserEmail } from '../util/git.js';
import type { Logger } from '../util/logger.js';
import { DocgenError } from '../util/errors.js';
import { syncGenerated } from '../verify/write.js';
import { computeExpectedFiles } from '../verify/expected.js';
import { captureWalkthroughFlow, readCaptureFlow } from '../walkthrough/capture.js';
import { loadWalkthroughs, prepareWalkthrough, readWalkthroughInput, reviewWalkthrough, saveWalkthrough } from '../walkthrough/store.js';
import { loadFeatureRecords } from '../features/store.js';

interface CommandBase { readonly cwd: string; readonly configFile?: string; readonly json?: boolean; readonly logger: Logger; }
export interface WalkthroughImportOptions extends CommandBase { readonly file: string; readonly update?: boolean; readonly dryRun?: boolean; }
export interface WalkthroughCaptureOptions extends WalkthroughImportOptions { readonly channel?: 'chrome' | 'msedge'; readonly headed?: boolean; readonly storageState?: string; }

async function publish(options: WalkthroughImportOptions, prepared: Awaited<ReturnType<typeof prepareWalkthrough>>): Promise<void> {
  const config = await loadConfig({ root: options.cwd, ...(options.configFile === undefined ? {} : { configFile: options.configFile }) });
  const records = await loadWalkthroughs(config.root, options.update === true ? { replacingId: prepared.record.id } : {});
  const existing = records.find((record) => record.id === prepared.record.id);
  if (existing !== undefined && options.update !== true) throw new DocgenError({ code: 'walkthrough-already-exists', message: `Walkthrough '${prepared.record.id}' already exists.`, remedy: 'Use --update to replace it with a new draft snapshot.' });
  if (existing === undefined && options.update === true) throw new DocgenError({ code: 'walkthrough-not-found', message: `Walkthrough '${prepared.record.id}' does not exist.`, remedy: 'Import it without --update.' });
  // Validate every current output target plus this guide before committing its record.
  const run = await runExtraction({ config, logger: options.logger, includeSymbols: (await loadFeatureRecords(config.root)).length > 0 });
  const expected = await computeExpectedFiles(run, { walkthroughRecords: [...records.filter((record) => record.id !== prepared.record.id), prepared.record] });
  await assertGeneratedTargets(config.root, [...new Set([
    ...expected.map((file) => file.path), `${config.outDir}/walkthroughs.md`, `${config.outDir}/walkthroughs/${prepared.record.id}.md`,
  ])]);
  if (options.dryRun === true) {
    options.logger.output(JSON.stringify({ dryRun: true, id: prepared.record.id, steps: prepared.record.steps.length, written: [] }, null, 2));
    return;
  }
  const recordFile = await saveWalkthrough(config.root, prepared, options.update === true);
  const synced = await syncGenerated({ config, logger: options.logger });
  const result = { id: prepared.record.id, status: 'draft', steps: prepared.record.steps.length, recordFile, written: synced.written };
  if (options.json === true) options.logger.output(JSON.stringify(result, null, 2));
  else {
    options.logger.heading('Screenshot walkthrough recorded');
    options.logger.info(`  guide     ${config.outDir}/walkthroughs/${prepared.record.id}.md`);
    options.logger.info(`  steps     ${prepared.record.steps.length}`);
    options.logger.info(`  review    draft; run docgen walkthrough review ${prepared.record.id} after checking the guide`);
  }
}

export async function runWalkthroughImportCommand(options: WalkthroughImportOptions): Promise<void> {
  const config = await loadConfig({ root: options.cwd, ...(options.configFile === undefined ? {} : { configFile: options.configFile }) });
  const loaded = await readWalkthroughInput(config.root, options.file);
  const prepared = await prepareWalkthrough({ root: config.root, ...loaded, source: 'import', recordedBy: (await resolveGitUserEmail(config.root)) ?? 'unknown' });
  await publish(options, prepared);
}

export async function runWalkthroughCaptureCommand(options: WalkthroughCaptureOptions): Promise<void> {
  const config = await loadConfig({ root: options.cwd, ...(options.configFile === undefined ? {} : { configFile: options.configFile }) });
  const flow = await readCaptureFlow(config.root, options.file);
  await assertGeneratedTargets(config.root, [`${config.outDir}/walkthroughs.md`, `${config.outDir}/walkthroughs/${flow.id}.md`]);
  const records = await loadWalkthroughs(config.root, options.update === true ? { replacingId: flow.id } : {});
  const existing = records.find((record) => record.id === flow.id);
  if (existing !== undefined && options.update !== true) throw new DocgenError({ code: 'walkthrough-already-exists', message: `Walkthrough '${flow.id}' already exists.`, remedy: 'Use --update to capture a new unreviewed snapshot.' });
  if (existing === undefined && options.update === true) throw new DocgenError({ code: 'walkthrough-not-found', message: `Walkthrough '${flow.id}' does not exist.`, remedy: 'Capture it without --update.' });
  const run = await runExtraction({ config, logger: options.logger, includeSymbols: (await loadFeatureRecords(config.root)).length > 0 });
  await assertGeneratedTargets(config.root, (await computeExpectedFiles(run, { walkthroughRecords: records })).map((file) => file.path));
  if (options.dryRun === true) {
    options.logger.output(JSON.stringify({ dryRun: true, id: flow.id, steps: flow.steps.length, written: [], browserStarted: false }, null, 2));
    return;
  }
  const captured = await captureWalkthroughFlow({ root: config.root, file: options.file,
    ...(options.channel === undefined ? {} : { channel: options.channel }), ...(options.headed === undefined ? {} : { headed: options.headed }),
    ...(options.storageState === undefined ? {} : { storageState: options.storageState }),
  });
  const prepared = await prepareWalkthrough({ root: config.root, ...captured, source: 'capture', recordedBy: (await resolveGitUserEmail(config.root)) ?? 'unknown' });
  await publish(options, prepared);
}

export async function runWalkthroughListCommand(options: CommandBase): Promise<void> {
  const config = await loadConfig({ root: options.cwd, ...(options.configFile === undefined ? {} : { configFile: options.configFile }) });
  const records = await loadWalkthroughs(config.root);
  const items = records.map((record) => ({ id: record.id, title: record.title, status: record.status, steps: record.steps.length, recordedBy: record.recordedBy }));
  if (options.json === true) options.logger.output(JSON.stringify({ count: items.length, walkthroughs: items }, null, 2));
  else {
    options.logger.heading(`Screenshot walkthroughs (${items.length})`);
    for (const item of items) options.logger.info(`  ${item.id}  ${item.title} [${item.status}, ${item.steps} steps]`);
  }
}

export async function runWalkthroughShowCommand(options: CommandBase & { readonly id: string }): Promise<void> {
  const config = await loadConfig({ root: options.cwd, ...(options.configFile === undefined ? {} : { configFile: options.configFile }) });
  const record = (await loadWalkthroughs(config.root)).find((item) => item.id === options.id);
  if (record === undefined) throw new DocgenError({ code: 'walkthrough-not-found', message: `Walkthrough '${options.id}' does not exist.`, remedy: 'Run docgen walkthrough list to see existing guides.' });
  options.logger.output(JSON.stringify(record, null, 2));
}

export async function runWalkthroughReviewCommand(options: CommandBase & { readonly id: string }): Promise<void> {
  const config = await loadConfig({ root: options.cwd, ...(options.configFile === undefined ? {} : { configFile: options.configFile }) });
  const reviewer = (await resolveGitUserEmail(config.root)) ?? 'unknown';
  const run = await runExtraction({ config, logger: options.logger, includeSymbols: (await loadFeatureRecords(config.root)).length > 0 });
  await assertGeneratedTargets(config.root, (await computeExpectedFiles(run)).map((file) => file.path));
  const record = await reviewWalkthrough(config.root, options.id, reviewer);
  await syncGenerated({ config, logger: options.logger });
  if (options.json === true) options.logger.output(JSON.stringify({ id: record.id, status: record.status, review: record.review }, null, 2));
  else options.logger.info(`Reviewed ${record.id} as ${reviewer}. Receipt saved in ${WALKTHROUGHS_DIR}/${record.id}.json.`);
}
