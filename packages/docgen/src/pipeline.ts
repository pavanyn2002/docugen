import { EXTRACTOR_IDS } from './types/core.js';
import type { ExtractResult, ExtractorId, GenerationContext } from './types/core.js';
import type { ResolvedConfig } from './config/schema.js';
import { getExtractors, getUnimplementedIds } from './extract/registry.js';
import { scopeExtractResult, type ExtractorContext } from './extract/types.js';
import { detectStack } from './detect/stack.js';
import type { StackReport } from './detect/stack.js';
import { resolveCommitInfo } from './util/git.js';
import { ENGINE_VERSION } from './util/version.js';
import type { Logger } from './util/logger.js';
import { buildEvidenceGraph } from './graph/from-extraction.js';
import type { EvidenceGraph } from './graph/types.js';
import { applySymbolLanguageAdapters } from './graph/language-adapters.js';
import type { SymbolLanguageAdapterReport } from './graph/language-adapters.js';
import { loadFeatureRecords } from './features/store.js';
import { mapFeaturesIntoGraph } from './features/graph.js';
import { loadPlanRecords } from './plans/store.js';
import { mapPlansIntoGraph } from './plans/graph.js';
import { loadChangeRecords } from './changes/store.js';
import { mapChangesIntoGraph } from './changes/graph.js';

export interface RunResult {
  readonly context: GenerationContext;
  readonly config: ResolvedConfig;
  /**
   * Every technology found in the repo, including ones docgen cannot parse.
   * Without this, a repo built on an unsupported stack produces empty output
   * that is indistinguishable from a repo with nothing to document.
   */
  readonly stack: StackReport;
  /** Results keyed by extractor id, for extractors that ran. */
  readonly results: ReadonlyMap<ExtractorId, ExtractResult>;
  /** Portable graph projection of the static facts. Not yet used by renderers. */
  readonly graph: EvidenceGraph;
  /** Symbol parsers that contributed to this run, empty when symbol indexing is disabled. */
  readonly symbolAdapters: readonly SymbolLanguageAdapterReport[];
  /** Enabled in config but not yet implemented in this build. */
  readonly unimplemented: readonly ExtractorId[];
  /** Turned off by the user in config or via `--only`. */
  readonly disabled: readonly ExtractorId[];
  readonly totalDurationMs: number;
}

export interface RunOptions {
  readonly config: ResolvedConfig;
  readonly logger: Logger;
  /** Restrict the run to these extractors (`--only`). Undefined means "all enabled". */
  readonly only?: readonly ExtractorId[];
  /**
   * Add symbol definitions and call edges to the evidence graph.
   *
   * Off by default so documentation commands keep their existing performance;
   * the dedicated graph index enables it explicitly.
   */
  readonly includeSymbols?: boolean;
  /** Rebuild only these repo-relative graph partitions. */
  readonly partitionFiles?: ReadonlySet<string>;
  /** Previously validated, unaffected evidence carried into a scoped run. */
  readonly seedGraph?: EvidenceGraph;
}

/**
 * Run the static lane.
 *
 * No network, no LLM, no writes — this function only reads the repo and
 * returns structured results. Rendering is a separate step so the same run can
 * be serialised to JSON, diffed, or re-rendered without re-parsing.
 */
export async function runExtraction(options: RunOptions): Promise<RunResult> {
  const { config, logger } = options;
  const startedAt = Date.now();

  const requested: readonly ExtractorId[] =
    options.only !== undefined && options.only.length > 0 ? options.only : EXTRACTOR_IDS;

  const disabled = requested.filter((id) => config.extractors[id] !== true);
  const enabled = requested.filter((id) => config.extractors[id] === true);

  const stack = await detectStack({ root: config.root, exclude: config.effectiveExclude });
  for (const tech of stack.unsupported) {
    logger.debug(`detected but unsupported: ${tech.name} (${tech.evidence.file})`);
  }

  const extractorContext: ExtractorContext = {
    root: config.root,
    config,
    logger,
    ...(options.partitionFiles === undefined ? {} : { partitionFiles: options.partitionFiles }),
  };
  const results = new Map<ExtractorId, ExtractResult>();

  for (const extractor of getExtractors()) {
    if (!enabled.includes(extractor.id)) continue;
    logger.debug(`running extractor: ${extractor.id}`);
    const extracted = await extractor.run(extractorContext);
    const result = scopeExtractResult(extracted, options.partitionFiles);
    results.set(extractor.id, result);
  }

  const commit = await resolveCommitInfo(config.root);
  const baseGraph = buildEvidenceGraph(results, options.seedGraph);
  const symbolRun =
    options.includeSymbols === true
      ? await applySymbolLanguageAdapters({
          graph: baseGraph,
          root: config.root,
          exclude: config.effectiveExclude,
          ...(options.partitionFiles === undefined ? {} : { partitionFiles: options.partitionFiles }),
        })
      : { graph: baseGraph, adapters: [] };
  const symbolGraph = symbolRun.graph;
  const [featureRecords, planRecords, changeRecords] = await Promise.all([
    loadFeatureRecords(config.root),
    loadPlanRecords(config.root),
    loadChangeRecords(config.root),
  ]);
  const featureGraph =
    featureRecords.length === 0
      ? symbolGraph
      : mapFeaturesIntoGraph(symbolGraph, featureRecords).graph;
  const planGraph = planRecords.length === 0 ? featureGraph : mapPlansIntoGraph(featureGraph, planRecords);
  const graph = changeRecords.length === 0 ? planGraph : mapChangesIntoGraph(planGraph, changeRecords);

  return {
    context: {
      engineVersion: ENGINE_VERSION,
      ...(commit === undefined ? {} : { sourceCommit: commit.sha, generatedAt: commit.committedAt }),
    },
    config,
    stack,
    results,
    graph,
    symbolAdapters: symbolRun.adapters,
    unimplemented: getUnimplementedIds(enabled),
    disabled,
    totalDurationMs: Date.now() - startedAt,
  };
}
