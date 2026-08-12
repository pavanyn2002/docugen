import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { analyzeChangeImpact } from '../graph/impact.js';
import { DEFAULT_GRAPH_INDEX, readEvidenceGraphIfExists } from '../graph/store.js';
import { runExtraction } from '../pipeline.js';
import { colors } from '../util/colors.js';
import { DocgenError } from '../util/errors.js';
import {
  resolveCommitInfo,
  filterGitChanges,
  resolveFileCommitHistory,
  resolveGitChanges,
} from '../util/git.js';
import type { FileCommitHistory } from '../util/git.js';
import type { Logger } from '../util/logger.js';
import { summarizeChangeSurfaces } from '../graph/impact-summary.js';

export interface ImpactCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  readonly base?: string;
  readonly maxDepth?: number;
  readonly limit?: number;
  readonly json?: boolean;
  readonly logger: Logger;
}

function requireLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new DocgenError({
      code: 'impact-limit-invalid',
      message: `Impact result limit must be a non-negative integer, got '${limit}'.`,
      remedy: 'Pass a whole number such as 50, or omit it to use 50 per file.',
    });
  }
  return limit;
}

const statusMarker = { added: '+', modified: '~', deleted: '-', renamed: 'R' } as const;

/** Analyze working-tree and committed branch changes without a model or network. */
export async function runImpactCommand(options: ImpactCommandOptions): Promise<void> {
  const limit = requireLimit(options.limit);
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const changes = filterGitChanges(
    await resolveGitChanges(config.root, options.base ?? 'HEAD'),
    config.effectiveExclude,
  );
  if (changes.changes.length === 0) {
    if (options.json === true) {
      options.logger.output(JSON.stringify({
        base: changes.base,
        head: await resolveCommitInfo(config.root),
        surfaceIds: [],
        featureIds: [],
        planIds: [],
        requirementIds: [],
        testFiles: [],
        generatedPages: [],
        files: [],
      }, null, 2));
      return;
    }
    options.logger.heading('Change impact');
    options.logger.info(`  ${colors().dim(`no changes relative to ${changes.base}`)}`);
    return;
  }

  const [run, baseline, head] = await Promise.all([
    runExtraction({ config, logger: options.logger, includeSymbols: true }),
    readEvidenceGraphIfExists(path.join(config.root, DEFAULT_GRAPH_INDEX)),
    resolveCommitInfo(config.root),
  ]);
  const report = analyzeChangeImpact({
    current: run.graph,
    ...(baseline === undefined ? {} : { baseline }),
    changes,
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
  });
  const histories = new Map<string, FileCommitHistory | undefined>();
  for (const file of report.files) {
    const currentHistory = await resolveFileCommitHistory(config.root, file.change.file);
    const previousHistory =
      currentHistory === undefined && file.change.previousFile !== undefined
        ? await resolveFileCommitHistory(config.root, file.change.previousFile)
        : undefined;
    histories.set(file.change.file, currentHistory ?? previousHistory);
  }

  const files = report.files.map((file) => ({
    change: file.change,
    history: histories.get(file.change.file),
    totalImpacted: file.impacted.length,
    impacted: file.impacted.slice(0, limit),
    truncated: file.impacted.length > limit,
  }));
  const surfaces = summarizeChangeSurfaces({ report, outDir: config.outDir });
  if (options.json === true) {
    options.logger.output(
      JSON.stringify({ base: report.base, head, maxDepth: report.maxDepth, baselineUsed: baseline !== undefined, ...surfaces, files }, null, 2),
    );
    return;
  }

  options.logger.heading(`Change impact (${files.length} file${files.length === 1 ? '' : 's'})`);
  options.logger.info(`  base       ${report.base}`);
  if (head !== undefined) options.logger.info(`  head       ${head.sha.slice(0, 12)} ${head.committedAt}`);
  options.logger.info(`  baseline   ${baseline === undefined ? 'not indexed' : 'previous index loaded'}`);
  options.logger.info(`  surfaces   ${surfaces.surfaceIds.join(', ') || 'none'}`);
  options.logger.info(`  requirements ${surfaces.requirementIds.join(', ') || 'none'}`);
  options.logger.info(`  tests      ${surfaces.testFiles.join(', ') || 'none'}`);
  options.logger.info(`  pages      ${surfaces.generatedPages.length}`);
  for (const file of files) {
    const marker = statusMarker[file.change.status];
    const rename = file.change.previousFile === undefined ? '' : ` <- ${file.change.previousFile}`;
    options.logger.heading(`${marker} ${file.change.file}${rename}`);
    if (file.history !== undefined) {
      options.logger.info(`  introduced ${file.history.introduced.committedAt}`);
      options.logger.info(`  last commit ${file.history.lastChanged.committedAt}`);
    }
    options.logger.info(`  affected   ${file.totalImpacted}`);
    for (const impact of file.impacted) {
      options.logger.info(
        `    d${impact.distance} ${impact.node.kind} ${impact.node.label} ${colors().dim(`[${impact.basis.join('+')}]`)}`,
      );
    }
    if (file.truncated) options.logger.info(`    ${colors().dim(`... ${file.totalImpacted - limit} more; use --limit`)}`);
  }
}
