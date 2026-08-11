import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { runExtraction } from '../pipeline.js';
import {
  DEFAULT_GRAPH_INDEX,
  ensureDefaultGraphCacheIgnored,
  readEvidenceGraphIfExists,
  writeEvidenceGraph,
} from '../graph/store.js';
import type { EvidenceGraph, GraphEdgeKind, GraphNodeKind } from '../graph/types.js';
import {
  DEFAULT_FILE_FINGERPRINT_INDEX,
  diffFileFingerprints,
  fingerprintFiles,
  readFileFingerprints,
  writeFileFingerprints,
} from '../graph/fingerprints.js';
import { DocgenError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { colors } from '../util/colors.js';
import {
  acceptScopedGraphPartitions,
  GLOBAL_GRAPH_PARTITION,
  mergeGraphPartitions,
  mergeReusableGraphPartitions,
  partitionEvidenceGraph,
  planGraphPartitionRebuild,
  updateGraphPartitions,
} from '../graph/partitions.js';
import type { IncrementalPartitionResult } from '../graph/partitions.js';
import {
  DEFAULT_GRAPH_PARTITION_INDEX,
  readGraphPartitions,
  writeGraphPartitions,
} from '../graph/partition-store.js';
import { serialiseEvidenceGraph } from '../graph/serialize.js';
import { ENGINE_VERSION } from '../util/version.js';
import { getSymbolLanguageAdapterReports } from '../graph/language-adapters.js';

export interface IndexGraphCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  readonly out?: string;
  readonly symbols?: boolean;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly logger: Logger;
}

export function resolveGraphIndexPath(root: string, requested?: string): string {
  const target = path.resolve(root, requested ?? DEFAULT_GRAPH_INDEX);
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new DocgenError({
      code: 'graph-index-outside-root',
      message: `Graph index must stay inside the target repository: ${target}.`,
      remedy: `Use a repo-relative path such as '${DEFAULT_GRAPH_INDEX}'.`,
      file: target,
    });
  }
  return target;
}

function countKinds<T extends string>(values: readonly T[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function summary(graph: EvidenceGraph): {
  nodes: number;
  edges: number;
  gaps: number;
  nodeKinds: Readonly<Record<string, number>>;
  edgeKinds: Readonly<Record<string, number>>;
} {
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    gaps: graph.gaps.length,
    nodeKinds: countKinds(graph.nodes.map((node) => node.kind as GraphNodeKind)),
    edgeKinds: countKinds(graph.edges.map((edge) => edge.kind as GraphEdgeKind)),
  };
}

/** Build the local graph cache. This is static analysis only and never calls a model. */
export async function runIndexGraphCommand(options: IndexGraphCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const file = resolveGraphIndexPath(config.root, options.out);
  const fingerprintFile = path.join(config.root, DEFAULT_FILE_FINGERPRINT_INDEX);
  const partitionFile = path.join(config.root, DEFAULT_GRAPH_PARTITION_INDEX);
  const includeSymbols = options.symbols !== false;
  const symbolAdapters = includeSymbols ? getSymbolLanguageAdapterReports() : [];
  const { root: _root, configFile: _configFile, ...resolvedConfig } = config;
  const profile = {
    engineVersion: ENGINE_VERSION,
    includeSymbols,
    configSha256: createHash('sha256').update(JSON.stringify(resolvedConfig)).digest('hex'),
    symbolAdaptersSha256: createHash('sha256').update(JSON.stringify(symbolAdapters)).digest('hex'),
  } as const;
  const [fingerprints, previousFingerprints, previousPartitions, previousGraph] = await Promise.all([
    fingerprintFiles({
      root: config.root,
      include: config.include,
      exclude: config.effectiveExclude,
      additionalInclude: [
        'docs/.features/**/*.json',
        'docs/.plans/**/*.json',
        'docs/.changes/**/*.json',
      ],
    }),
    readFileFingerprints(fingerprintFile),
    readGraphPartitions(partitionFile),
    readEvidenceGraphIfExists(file),
  ]);
  const changes = diffFileFingerprints(previousFingerprints, fingerprints);
  const changeCounts = {
    added: changes.added.length,
    changed: changes.changed.length,
    deleted: changes.deleted.length,
    unchanged: changes.unchanged.length,
  };
  const noFingerprintChanges =
    changes.added.length === 0 && changes.changed.length === 0 && changes.deleted.length === 0;
  const profileMatches =
    previousPartitions?.engineVersion === profile.engineVersion &&
    previousPartitions.includeSymbols === profile.includeSymbols &&
    previousPartitions.configSha256 === profile.configSha256 &&
    previousPartitions.symbolAdaptersSha256 === profile.symbolAdaptersSha256;
  let graphMatchesPartitions = false;
  if (previousGraph !== undefined && previousPartitions !== undefined) {
    graphMatchesPartitions =
      serialiseEvidenceGraph(previousGraph) ===
      serialiseEvidenceGraph(mergeGraphPartitions(previousPartitions));
  }
  const cacheHit =
    noFingerprintChanges && profileMatches && graphMatchesPartitions && previousGraph !== undefined;

  if (cacheHit) {
    const counts = summary(previousGraph);
    const contents = serialiseEvidenceGraph(previousGraph);
    const cached = {
      file: path.resolve(file),
      bytes: Buffer.byteLength(contents),
      sha256: createHash('sha256').update(contents).digest('hex'),
    };
    const partitionSummary = {
      mode: 'cached' as const,
      total: previousPartitions.partitions.length,
      invalidated: 0,
      reused: previousPartitions.partitions.length,
      equivalent: true,
      verification: 'cache-integrity' as const,
    };

    if (options.dryRun === true) {
      if (options.json === true) {
        options.logger.output(
          JSON.stringify(
            {
              dryRun: true,
              cacheHit: true,
              extractionSkipped: true,
              fingerprintFile,
              partitionFile,
              includeSymbols,
              symbolAdapters,
              ...counts,
              ...cached,
              changes: changeCounts,
              partitions: partitionSummary,
            },
            null,
            2,
          ),
        );
        return;
      }
      options.logger.heading('docgen index (dry run)');
      options.logger.info(`  nodes     ${counts.nodes}`);
      options.logger.info(`  edges     ${counts.edges}`);
      options.logger.info(`  gaps      ${counts.gaps}`);
      options.logger.info(`  changes   +0 ~0 -0`);
      options.logger.info(`  partitions cached; ${partitionSummary.reused} reused, 0 invalidated`);
      options.logger.info(`  ${colors().dim(`would reuse ${cached.file} without extraction`)}`);
      return;
    }

    const ignored = await ensureDefaultGraphCacheIgnored(config.root);
    if (options.json === true) {
      options.logger.output(
        JSON.stringify(
          {
            dryRun: false,
            cacheHit: true,
            extractionSkipped: true,
            includeSymbols,
            symbolAdapters,
            ...counts,
            ...cached,
            changes: changeCounts,
            partitions: partitionSummary,
            cacheIgnoreCreated: ignored,
          },
          null,
          2,
        ),
      );
      return;
    }
    options.logger.heading('docgen index');
    options.logger.info(`  nodes     ${counts.nodes}`);
    options.logger.info(`  edges     ${counts.edges}`);
    options.logger.info(`  gaps      ${counts.gaps}`);
    options.logger.info(`  changes   +0 ~0 -0`);
    options.logger.info(`  partitions cached; ${partitionSummary.reused} reused, 0 invalidated`);
    options.logger.info(`  bytes     ${cached.bytes}`);
    options.logger.info(`  cached    ${cached.file}`);
    options.logger.info(`  tracked   ${fingerprints.files.length} files`);
    if (ignored) options.logger.info(`  ${colors().dim('created cache-local .gitignore')}`);
    return;
  }

  const rebuild = planGraphPartitionRebuild({
    ...(previousPartitions === undefined ? {} : { previous: previousPartitions }),
    changes,
    profile,
  });
  let run;
  let partitions: IncrementalPartitionResult;
  let extractionScope: { readonly mode: 'full' | 'scoped' | 'fallback'; readonly files: number };

  if (rebuild.mode === 'incremental' && previousPartitions !== undefined) {
    const currentFiles = new Set(fingerprints.files.map((entry) => entry.file));
    const partitionFiles = new Set(
      rebuild.invalidated.filter(
        (key) => key !== GLOBAL_GRAPH_PARTITION && currentFiles.has(key),
      ),
    );
    let accepted: IncrementalPartitionResult | undefined;
    try {
      const seedGraph = mergeReusableGraphPartitions(previousPartitions, rebuild.invalidated);
      run = await runExtraction({
        config,
        logger: options.logger,
        includeSymbols,
        partitionFiles,
        seedGraph,
      });
      accepted = acceptScopedGraphPartitions({
        previous: previousPartitions,
        graph: run.graph,
        fingerprints,
        invalidated: rebuild.invalidated,
        profile,
      });
    } catch (error) {
      // A scoped merge can expose a missed dependency or semantic id conflict.
      // Those are cache limitations, not repository errors, so rebuild cleanly.
      if (!(error instanceof DocgenError) || !error.code.startsWith('graph-')) throw error;
      accepted = undefined;
    }
    if (accepted !== undefined) {
      partitions = accepted;
      extractionScope = { mode: 'scoped', files: partitionFiles.size };
    } else {
      run = await runExtraction({ config, logger: options.logger, includeSymbols });
      partitions = {
        manifest: partitionEvidenceGraph(run.graph, fingerprints, profile),
        mode: 'fallback',
        invalidated: rebuild.invalidated,
        reused: [],
        candidateEquivalent: false,
        verification: 'clean-equivalent',
      };
      extractionScope = { mode: 'fallback', files: fingerprints.files.length };
    }
  } else {
    run = await runExtraction({ config, logger: options.logger, includeSymbols });
    partitions = updateGraphPartitions({
      ...(previousPartitions === undefined ? {} : { previous: previousPartitions }),
      cleanGraph: run.graph,
      fingerprints,
      changes,
      profile,
    });
    extractionScope = { mode: 'full', files: fingerprints.files.length };
  }
  if (run === undefined) {
    throw new DocgenError({
      code: 'graph-index-run-missing',
      message: 'Graph indexing completed without an extraction result.',
      remedy: 'Retry the index; if this persists, report it as an internal docgen defect.',
    });
  }
  const counts = summary(run.graph);
  const partitionSummary = {
    mode: partitions.mode,
    total: partitions.manifest.partitions.length,
    invalidated: partitions.invalidated.length,
    reused: partitions.reused.length,
    equivalent: partitions.candidateEquivalent,
    verification: partitions.verification,
  };

  if (options.dryRun === true) {
    if (options.json === true) {
      options.logger.output(
        JSON.stringify({ dryRun: true, cacheHit: false, extractionSkipped: false, extractionScope, file, fingerprintFile, partitionFile, includeSymbols, symbolAdapters: run.symbolAdapters, ...counts, changes: changeCounts, partitions: partitionSummary }, null, 2),
      );
      return;
    }
    options.logger.heading('docgen index (dry run)');
    options.logger.info(`  nodes     ${counts.nodes}`);
    options.logger.info(`  edges     ${counts.edges}`);
    options.logger.info(`  gaps      ${counts.gaps}`);
    options.logger.info(`  changes   +${changeCounts.added} ~${changeCounts.changed} -${changeCounts.deleted}`);
    options.logger.info(`  partitions ${partitionSummary.mode}; ${partitionSummary.reused} reused, ${partitionSummary.invalidated} invalidated`);
    options.logger.info(`  ${colors().dim(`would write ${file}`)}`);
    return;
  }

  const ignored = await ensureDefaultGraphCacheIgnored(config.root);
  const [written, fingerprintIndex, partitionIndex] = await Promise.all([
    writeEvidenceGraph(file, run.graph),
    writeFileFingerprints(fingerprintFile, fingerprints),
    writeGraphPartitions(partitionFile, partitions.manifest),
  ]);

  if (options.json === true) {
    options.logger.output(
      JSON.stringify(
        {
          dryRun: false,
          cacheHit: false,
          extractionSkipped: false,
          extractionScope,
          includeSymbols,
          symbolAdapters: run.symbolAdapters,
          ...counts,
          ...written,
          changes: changeCounts,
          fingerprintIndex,
          partitionIndex,
          partitions: partitionSummary,
          cacheIgnoreCreated: ignored,
        },
        null,
        2,
      ),
    );
    return;
  }

  options.logger.heading('docgen index');
  options.logger.info(`  nodes     ${counts.nodes}`);
  options.logger.info(`  edges     ${counts.edges}`);
  options.logger.info(`  gaps      ${counts.gaps}`);
  options.logger.info(`  changes   +${changeCounts.added} ~${changeCounts.changed} -${changeCounts.deleted}`);
  options.logger.info(`  partitions ${partitionSummary.mode}; ${partitionSummary.reused} reused, ${partitionSummary.invalidated} invalidated`);
  options.logger.info(`  bytes     ${written.bytes}`);
  options.logger.info(`  written   ${written.file}`);
  options.logger.info(`  tracked   ${fingerprints.files.length} files`);
  if (ignored) options.logger.info(`  ${colors().dim('created cache-local .gitignore')}`);
}
