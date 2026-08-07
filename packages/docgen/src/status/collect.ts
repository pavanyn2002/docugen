import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { ALWAYS_EXCLUDE } from '../config/schema.js';
import { runExtraction } from '../pipeline.js';
import { chunkSurfaces } from '../surface/chunk.js';
import { loadCards } from '../infer/store.js';
import { loadAnswers } from '../questions/store.js';
import { buildQueue } from '../questions/queue.js';
import { loadRequirements } from '../requirements/store.js';
import { buildPending } from '../requirements/pending.js';
import { countByKind } from '../requirements/render.js';
import { scanTestReferences } from '../trace/scan.js';
import { buildMatrix } from '../trace/matrix.js';
import { computeExpectedFiles, findDrift } from '../verify/expected.js';
import { ENGINE_VERSION } from '../util/version.js';
import { toPosix } from '../util/paths.js';
import type { RequirementKind } from '../requirements/types.js';
import type { Logger } from '../util/logger.js';
import type { JobsResult, RoutesResult, EndpointsResult } from '../types/entries.js';

/**
 * One repository's documentation health, in a shape that aggregates.
 *
 * Rolling this out across a fleet needs a number per repo that means the same
 * thing everywhere, and it has to be honest about the denominator: "12
 * requirements" says nothing without knowing there are 40 surfaces, 34 of which
 * nobody has described at all. Every count here is paired with what it is a
 * count of.
 *
 * Calls no model, so running it over forty repositories costs nothing.
 */
export interface RepoStatus {
  readonly name: string;
  readonly root: string;
  readonly engineVersion: string;
  readonly surfaces: number;
  /** Surfaces with a committed feature card. */
  readonly described: number;
  readonly openQuestions: number;
  readonly answered: number;
  readonly untriaged: number;
  readonly requirements: Readonly<Record<RequirementKind, number>>;
  readonly testable: number;
  readonly tested: number;
  readonly untestedRequirements: number;
  readonly danglingReferences: number;
  readonly untracedSurfaces: number;
  /** Generated files that would change if `docgen sync` ran now. */
  readonly driftingFiles: number;
  /** Technologies detected but not parseable, so coverage is known-incomplete. */
  readonly unsupportedTechnologies: readonly string[];
}

export async function collectStatus(args: {
  cwd: string;
  configFile?: string;
  logger: Logger;
}): Promise<RepoStatus> {
  const config = await loadConfig({
    root: args.cwd,
    ...(args.configFile === undefined ? {} : { configFile: args.configFile }),
  });

  const run = await runExtraction({ config, logger: args.logger });

  const surfaceSet = chunkSurfaces({
    routes: (run.results.get('routes') as RoutesResult | undefined)?.entries ?? [],
    endpoints: (run.results.get('endpoints') as EndpointsResult | undefined)?.entries ?? [],
    jobs: (run.results.get('jobs') as JobsResult | undefined)?.entries ?? [],
    overrides: config.surfaces.overrides.map((override) => ({
      id: override.id,
      kind: override.kind,
      include: override.include,
      ...(override.title === undefined ? {} : { title: override.title }),
    })),
    apiBasePaths: config.surfaces.apiBasePaths,
  });

  const cards = [...(await loadCards(config.root)).values()];
  const answers = await loadAnswers(config.root);
  const requirements = await loadRequirements(config.root);

  const references = await scanTestReferences({
    root: config.root,
    globs: config.trace.include,
    exclude: [...config.exclude, ...ALWAYS_EXCLUDE],
  });
  const matrix = buildMatrix({ requirements, cards, references, answers });

  const drift = await findDrift(
    config.root,
    toPosix(config.outDir),
    await computeExpectedFiles(run),
  );

  return {
    name: path.basename(config.root),
    root: config.root,
    engineVersion: ENGINE_VERSION,
    surfaces: surfaceSet.surfaces.length,
    described: cards.length,
    openQuestions: buildQueue({ cards, answers }).questions.length,
    answered: [...answers.values()].reduce((total, surface) => total + surface.answers.length, 0),
    untriaged: buildPending({ cards, answers, requirements }).length,
    requirements: countByKind(requirements),
    testable: matrix.testableCount,
    tested: matrix.testedCount,
    untestedRequirements: matrix.untested.length,
    danglingReferences: matrix.danglingReferences.length,
    untracedSurfaces: matrix.untracedSurfaces.length,
    driftingFiles: drift.length,
    unsupportedTechnologies: run.stack.unsupported.map((tech) => tech.name),
  };
}
