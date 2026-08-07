/** Programmatic entrypoint. The CLI is a thin wrapper over these. */
export { defineConfig } from './config/define.js';
export { loadConfig, findConfigFile, CONFIG_FILENAMES } from './config/load.js';
export { docgenConfigSchema, ALWAYS_EXCLUDE } from './config/schema.js';
export type { DocgenConfig, DocgenUserConfig, ResolvedConfig } from './config/schema.js';

export { runExtraction } from './pipeline.js';
export type { RunResult, RunOptions } from './pipeline.js';

export { getExtractors, getRegisteredIds } from './extract/registry.js';
export { inapplicable, skip } from './extract/types.js';
export type { Extractor, ExtractorContext } from './extract/types.js';

export { DocgenError, isDocgenError } from './util/errors.js';
export { createLogger } from './util/logger.js';
export type { Logger, LogLevel } from './util/logger.js';
export { ENGINE_VERSION } from './util/version.js';

export * from './types/core.js';
export * from './types/entries.js';
