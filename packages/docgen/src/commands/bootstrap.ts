import { colors } from '../util/colors.js';
import { loadConfig } from '../config/load.js';
import { runExtraction } from '../pipeline.js';
import { chunkSurfaces } from '../surface/chunk.js';
import { resolveBackend, probeBackends } from '../agents/registry.js';
import { inferCards } from '../infer/cards.js';
import { loadCards, saveCards } from '../infer/store.js';
import { loadAnswers } from '../questions/store.js';
import { buildQueue, resolveOwners } from '../questions/queue.js';
import type {
  ConfigResult,
  EndpointsResult,
  JobsResult,
  RoutesResult,
  SchemaResult,
} from '../types/entries.js';
import type { Logger } from '../util/logger.js';

export interface BootstrapCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  /** Re-run every surface even when unchanged. */
  readonly force?: boolean;
  /** Bound a first run so a team can see the output before paying for all of it. */
  readonly limit?: number;
  /** Show what would run, and what it would cost, without calling a model. */
  readonly dryRun?: boolean;
  readonly logger: Logger;
}

/**
 * `docgen bootstrap` — the Phase 1 inference pass.
 *
 * This is the first command that spends money and the first that can be wrong,
 * so it is deliberately explicit about both: it reports what it will run before
 * running it, reuses unchanged surfaces, and reports every surface it failed to
 * describe rather than quietly producing fewer cards.
 */
export async function runBootstrapCommand(options: BootstrapCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });

  options.logger.heading('docgen bootstrap');
  options.logger.info(`  root      ${config.root}`);

  // Static lane first. Inference is grounded in these facts, and the surface
  // list is what gets chunked into cards.
  const run = await runExtraction({ config, logger: options.logger });
  const bundle = {
    routes: run.results.get('routes') as RoutesResult | undefined,
    endpoints: run.results.get('endpoints') as EndpointsResult | undefined,
    schema: run.results.get('schema') as SchemaResult | undefined,
    jobs: run.results.get('jobs') as JobsResult | undefined,
    config: run.results.get('config') as ConfigResult | undefined,
  };

  const surfaceSet = chunkSurfaces({
    routes: bundle.routes?.entries ?? [],
    endpoints: bundle.endpoints?.entries ?? [],
    jobs: bundle.jobs?.entries ?? [],
    overrides: config.surfaces.overrides.map((override) => ({
      id: override.id,
      kind: override.kind,
      include: override.include,
      ...(override.title === undefined ? {} : { title: override.title }),
    })),
    apiBasePaths: config.surfaces.apiBasePaths,
  });

  if (surfaceSet.surfaces.length === 0) {
    options.logger.warn(
      'No surfaces were found, so there is nothing to describe. Run `docgen extract` first ' +
        'and check that it finds routes, endpoints, or jobs.',
    );
    return;
  }

  const previous = await loadCards(config.root);
  const answers = await loadAnswers(config.root);

  const targetCount =
    options.limit === undefined
      ? surfaceSet.surfaces.length
      : Math.min(options.limit, surfaceSet.surfaces.length);

  options.logger.heading('Surfaces');
  options.logger.info(`  found     ${surfaceSet.surfaces.length}`);
  options.logger.info(`  cached    ${previous.size}`);
  options.logger.info(`  answers   ${[...answers.values()].reduce((n, s) => n + s.answers.length, 0)} on record`);
  if (options.limit !== undefined) {
    options.logger.info(`  ${colors().dim(`--limit ${options.limit}: only the first ${targetCount} will run`)}`);
  }

  if (options.dryRun === true) {
    await reportBackends(options.logger);
    options.logger.heading('Dry run');
    options.logger.info(`  ${colors().dim('no model was called and nothing was written')}`);
    return;
  }

  const backend = await resolveBackend(config.infer.agent);
  options.logger.heading(`Inferring with ${backend.name}`);
  options.logger.warn(
    'Everything produced below is model-inferred and unverified. It is badged as such in the ' +
      'output, and stays that way until a developer answers the questions it raises.',
  );

  const result = await inferCards({
    root: config.root,
    surfaces: surfaceSet.surfaces,
    bundle,
    answers,
    backend,
    limits: {
      maxFiles: config.infer.maxFilesPerSurface,
      maxBytesPerFile: config.infer.maxBytesPerFile,
      maxTotalBytes: config.infer.maxBytesPerSurface,
    },
    timeoutMs: config.infer.timeoutMs,
    ...(config.infer.model === undefined ? {} : { model: config.infer.model }),
    previous,
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.limit === undefined ? {} : { maxSurfaces: options.limit }),
    logger: options.logger,
  });

  const written = await saveCards(config.root, result.cards);

  const filesBySurface = new Map(surfaceSet.surfaces.map((s) => [s.id, s.sourceFiles]));
  const owners = await resolveOwners({ root: config.root, cards: result.cards, filesBySurface });
  const queue = buildQueue({ cards: result.cards, answers, ownersBySurface: owners });

  options.logger.heading('Result');
  options.logger.info(`  cards     ${result.cards.length} (${result.reused.length} reused unchanged)`);
  options.logger.info(`  written   ${written.length} files under docs/.cards/`);
  options.logger.info(`  questions ${queue.questions.length} open`);

  if (result.failures.length > 0) {
    // A surface docgen could not describe is reported, never silently dropped.
    options.logger.warn(
      `${result.failures.length} surface(s) could not be described. No card was written for these — ` +
        'they are absent from the documentation, not empty in it:',
    );
    for (const failure of result.failures.slice(0, 10)) {
      options.logger.warn(`  ${failure.title} — ${failure.reason}`);
    }
    if (result.failures.length > 10) {
      options.logger.warn(`  … and ${result.failures.length - 10} more`);
    }
  }

  if (queue.questions.length > 0) {
    options.logger.info(
      `\n  ${colors().dim('Next: run `docgen ask` to work through the open questions.')}`,
    );
  }
}

async function reportBackends(logger: Logger): Promise<void> {
  logger.heading('Available backends');
  for (const backend of await probeBackends()) {
    const mark = backend.available ? colors().green(' ok') : colors().dim('  -');
    logger.info(`  ${mark} ${backend.name}`);
    if (!backend.available) logger.info(`       ${colors().dim(backend.setupHint)}`);
  }
}
