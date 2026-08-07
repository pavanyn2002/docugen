import { EXTRACTOR_IDS } from './types/core.js';
import type { ExtractResult, ExtractorId, GenerationContext } from './types/core.js';
import type { ResolvedConfig } from './config/schema.js';
import { getExtractors, getUnimplementedIds } from './extract/registry.js';
import type { ExtractorContext } from './extract/types.js';
import { detectStack } from './detect/stack.js';
import type { StackReport } from './detect/stack.js';
import { resolveSourceCommit } from './util/git.js';
import { ENGINE_VERSION } from './util/version.js';
import type { Logger } from './util/logger.js';

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
  /** Injectable clock so tests can assert byte-determinism. */
  readonly now?: () => Date;
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

  const extractorContext: ExtractorContext = { root: config.root, config, logger };
  const results = new Map<ExtractorId, ExtractResult>();

  for (const extractor of getExtractors()) {
    if (!enabled.includes(extractor.id)) continue;
    logger.debug(`running extractor: ${extractor.id}`);
    const result = await extractor.run(extractorContext);
    results.set(extractor.id, result);
  }

  const sourceCommit = await resolveSourceCommit(config.root);
  const now = options.now?.() ?? new Date();

  return {
    context: {
      engineVersion: ENGINE_VERSION,
      ...(sourceCommit === undefined ? {} : { sourceCommit }),
      generatedAt: now.toISOString(),
    },
    config,
    stack,
    results,
    unimplemented: getUnimplementedIds(enabled),
    disabled,
    totalDurationMs: Date.now() - startedAt,
  };
}
