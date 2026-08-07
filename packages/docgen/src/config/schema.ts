import { z } from 'zod';
import { DEFAULT_TEST_GLOBS } from './paths.js';
import { EXTRACTOR_IDS } from '../types/core.js';

/**
 * Directories that are never source code. Excluded before globbing so large
 * repos stay inside the 30s budget. Users add to this via `exclude`; these are
 * always applied and cannot be switched off.
 */
export const ALWAYS_EXCLUDE: readonly string[] = Object.freeze([
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/__snapshots__/**',
  '**/*.min.js',
  // docgen must never document its own output. Without this a second run reads
  // the first run's files, and any `.env`-shaped or code-shaped content in them
  // feeds back into the results.
  '**/docs/generated/**',
  // Same reason, for the Phase 1 stores: inferred cards and recorded answers
  // are docgen's own bookkeeping, not source material to be documented.
  '**/docs/.cards/**',
  '**/docs/.answers/**',
  '**/docs/.requirements/**',
]);

/** Node-count ceiling above which a diagram aggregates instead of emitting a hairball (SPEC 6.3). */
const DEFAULT_MAX_DIAGRAM_NODES = 40;

const sourceRefPatternHelp =
  'a repo-relative glob, e.g. "src/legacy/**" — absolute paths are rejected because output must be portable';

const globList = z
  .array(
    z
      .string()
      .min(1)
      .refine((p) => !p.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(p), {
        message: `must be ${sourceRefPatternHelp}`,
      }),
  )
  .readonly();

/**
 * Manual surface chunking override. The chunker's heuristics will be wrong on
 * some repos; this is the escape hatch that does not require a code change.
 */
const surfaceOverrideSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['screen', 'endpoint-group', 'job']),
    title: z.string().min(1).optional(),
    /** Files belonging to this surface. */
    include: globList,
  })
  .strict();

const extractorToggles = z.object(
  Object.fromEntries(EXTRACTOR_IDS.map((id) => [id, z.boolean().default(true)])) as {
    [K in (typeof EXTRACTOR_IDS)[number]]: z.ZodDefault<z.ZodBoolean>;
  },
);

export const docgenConfigSchema = z
  .object({
    /** Where generated markdown and diagrams are written, relative to the repo root. */
    outDir: z.string().min(1).default('docs/generated'),

    /** Source globs to scan. Defaults to the whole repo minus ALWAYS_EXCLUDE. */
    include: globList.default(['**/*']),

    /** Additional exclusions — vendored code, generated clients, legacy dirs. */
    exclude: globList.default([]),

    extractors: extractorToggles.default({}),

    diagrams: z
      .object({
        maxNodes: z.number().int().positive().default(DEFAULT_MAX_DIAGRAM_NODES),
      })
      .strict()
      .default({}),

    surfaces: z
      .object({
        overrides: z.array(surfaceOverrideSchema).readonly().default([]),
        /**
         * Mount prefixes stripped before endpoints are grouped by resource.
         * `api` and `v1`-style version segments are always stripped; this is
         * for repos that mount everything under something else, e.g.
         * '/service/internal', where every endpoint would otherwise collapse
         * into one surface named after the mount point.
         */
        apiBasePaths: z.array(z.string().min(1)).readonly().default([]),
      })
      .strict()
      .default({}),

    openapi: z
      .object({
        /**
         * 'cross-check' (default): endpoints come from the AST; a declared spec
         * is compared and disagreements are reported as gaps. 'ignore': the
         * spec is not read at all.
         *
         * There is deliberately no 'trust-spec' mode. A stale annotation
         * emitted as verified fact is precisely the failure this tool exists to
         * prevent (SPEC section 3).
         */
        mode: z.enum(['cross-check', 'ignore']).default('cross-check'),
        /** Explicit spec path when it is not in a conventional location. */
        path: z.string().min(1).optional(),
      })
      .strict()
      .default({}),

    /** Append `docs/generated/** linguist-generated=true` to .gitattributes (SPEC 6.2). */
    gitattributes: z.boolean().default(true),

    /**
     * Where to look for tests citing a requirement id.
     *
     * Overridable because "what counts as a test" varies enormously across
     * stacks, and a test directory this misses is reported as a requirement
     * nothing covers — a false alarm that makes the whole matrix untrustworthy.
     */
    trace: z
      .object({
        include: globList.default([...DEFAULT_TEST_GLOBS]),
      })
      .strict()
      .default({}),

    /**
     * Phase 1 inference. Every setting here costs money when `docgen bootstrap`
     * runs, so the defaults are conservative and the backend is whatever CLI
     * the developer already has signed in.
     */
    infer: z
      .object({
        /**
         * 'auto' picks the first available coding CLI. An explicitly named
         * backend that is unavailable is an error rather than a silent
         * downgrade — switching models changes both output and cost.
         */
        agent: z.enum(['auto', 'claude', 'codex', 'cursor', 'api']).default('auto'),
        /** Model override. Omit to use whatever the backend defaults to. */
        model: z.string().min(1).optional(),
        /** Source files sent per surface. */
        maxFilesPerSurface: z.number().int().positive().max(100).default(12),
        maxBytesPerFile: z.number().int().positive().default(24_000),
        maxBytesPerSurface: z.number().int().positive().default(120_000),
        /** A large surface on a slow backend legitimately takes minutes. */
        timeoutMs: z.number().int().positive().default(180_000),
      })
      .strict()
      .default({}),
  })
  .strict();

/** User-facing config shape: every field optional. */
export type DocgenUserConfig = z.input<typeof docgenConfigSchema>;

/** Fully-defaulted config used internally. */
export type DocgenConfig = z.output<typeof docgenConfigSchema>;

/** Resolved config plus the runtime context it was resolved in. */
export interface ResolvedConfig extends DocgenConfig {
  /** Absolute path to the target repo root. */
  readonly root: string;
  /** Absolute path of the config file that was loaded, if any. */
  readonly configFile?: string;
  /** ALWAYS_EXCLUDE plus the user's `exclude`. */
  readonly effectiveExclude: readonly string[];
}
