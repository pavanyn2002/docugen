import fs from 'node:fs/promises';
import path from 'node:path';
import { createJiti } from 'jiti';
import { docgenConfigSchema, ALWAYS_EXCLUDE } from './schema.js';
import { readGitignore } from './gitignore.js';
import type { ResolvedConfig } from './schema.js';
import { DocgenError, describeUnknownError } from '../util/errors.js';

/**
 * Config filenames, in resolution order. The first that exists wins; a repo
 * with two of them is an error rather than a silent coin-flip.
 */
export const CONFIG_FILENAMES: readonly string[] = Object.freeze([
  'docgen.config.ts',
  'docgen.config.mts',
  'docgen.config.mjs',
  'docgen.config.js',
  'docgen.config.cjs',
  'docgen.config.json',
]);

async function exists(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/** Find the config file in `root`, or undefined when the repo has none. */
export async function findConfigFile(root: string): Promise<string | undefined> {
  const found: string[] = [];
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(root, name);
    if (await exists(candidate)) found.push(candidate);
  }

  if (found.length > 1) {
    throw new DocgenError({
      code: 'config-ambiguous',
      message: `Found ${found.length} docgen config files: ${found.map((f) => path.basename(f)).join(', ')}.`,
      remedy: 'Delete all but one so it is unambiguous which config is in effect.',
      file: found[0] as string,
    });
  }

  return found[0];
}

/**
 * Import a config module. `.ts` is handled by jiti so target repos can write a
 * typed config without needing a build step of their own.
 */
async function importConfigModule(file: string): Promise<unknown> {
  if (file.endsWith('.json')) {
    const raw = await fs.readFile(file, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (cause) {
      throw new DocgenError({
        code: 'config-unparseable',
        message: `${path.basename(file)} is not valid JSON: ${describeUnknownError(cause)}`,
        remedy: 'Fix the JSON syntax, or delete the file to fall back to defaults.',
        file,
        cause,
      });
    }
  }

  const jiti = createJiti(import.meta.url, { interopDefault: true });
  try {
    return await jiti.import(file, { default: true });
  } catch (cause) {
    throw new DocgenError({
      code: 'config-unparseable',
      message: `Failed to load ${path.basename(file)}: ${describeUnknownError(cause)}`,
      remedy:
        'Fix the error in your docgen config, or delete the file to fall back to defaults. ' +
        'The config is evaluated as a module, so top-level code in it runs.',
      file,
      cause,
    });
  }
}

/**
 * Load and validate config for a target repo.
 *
 * Absent config is not an error — the tool must work on a repo that has never
 * heard of it (SPEC rule 6). Malformed config is a loud error, because silently
 * ignoring a typo'd exclude glob would produce quietly wrong documentation.
 */
export async function loadConfig(options: {
  root: string;
  /** Explicit `--config` path. Its absence *is* an error, unlike auto-discovery. */
  configFile?: string;
}): Promise<ResolvedConfig> {
  const root = path.resolve(options.root);

  // Without this, a mistyped --cwd runs happily against nothing: every
  // extractor finds zero entries, and the output looks like a repo that
  // genuinely has no routes rather than a path that does not exist.
  if (!(await isDirectory(root))) {
    throw new DocgenError({
      code: 'root-not-found',
      message: `Not a directory: ${root}`,
      remedy: 'Check the --cwd path. docgen needs the root of a repository that exists.',
      file: root,
    });
  }

  let file: string | undefined;
  if (options.configFile !== undefined) {
    file = path.resolve(root, options.configFile);
    if (!(await exists(file))) {
      throw new DocgenError({
        code: 'config-not-found',
        message: `Config file not found: ${file}`,
        remedy: 'Check the --config path, or omit --config to auto-discover docgen.config.ts.',
        file,
      });
    }
  } else {
    file = await findConfigFile(root);
  }

  const raw = file === undefined ? {} : await importConfigModule(file);

  if (raw === null || typeof raw !== 'object') {
    throw new DocgenError({
      code: 'config-invalid',
      message: `${file === undefined ? 'Config' : path.basename(file)} must export an object, got ${raw === null ? 'null' : typeof raw}.`,
      remedy: 'Export a config object as the default export, e.g. `export default defineConfig({ ... })`.',
      ...(file === undefined ? {} : { file }),
    });
  }

  const parsed = docgenConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new DocgenError({
      code: 'config-invalid',
      message: `Invalid docgen config:\n${issues}`,
      remedy: 'Correct the fields listed above. Unknown keys are rejected on purpose, so check for typos.',
      ...(file === undefined ? {} : { file }),
    });
  }

  const gitignore = parsed.data.respectGitignore ? await readGitignore(root) : undefined;

  return {
    ...parsed.data,
    root,
    ...(file === undefined ? {} : { configFile: file }),
    effectiveExclude: [
      ...ALWAYS_EXCLUDE,
      ...parsed.data.exclude,
      ...(gitignore?.patterns ?? []),
    ],
    gitignoreNegations: gitignore?.unsupportedNegations ?? [],
  };
}
