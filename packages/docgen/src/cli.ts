#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { colors, configureColors, resolveColorEnabled } from './util/colors.js';
import { runExtractCommand } from './commands/extract.js';
import { runReportCommand } from './commands/report.js';
import { PLANNED_COMMANDS, runStub } from './commands/stub.js';
import { createLogger } from './util/logger.js';
import type { LogLevel } from './util/logger.js';
import { describeUnknownError, isDocgenError } from './util/errors.js';
import { ENGINE_VERSION } from './util/version.js';

interface GlobalOptions {
  cwd?: string;
  config?: string;
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
}

function resolveLogLevel(options: GlobalOptions): LogLevel {
  if (options.quiet === true) return 'error';
  if (options.verbose === true) return 'debug';
  return 'info';
}

export function buildCli(): Command {
  const program = new Command();

  program
    .name('docgen')
    .description(
      'Deterministic codebase documentation engine.\n' +
        'Extracts what the code proves. Never states what it cannot verify.',
    )
    .version(ENGINE_VERSION, '-v, --version')
    .option('--cwd <path>', 'target repo root', process.cwd())
    .option('-c, --config <path>', 'path to docgen config (default: auto-discover)')
    .option('--verbose', 'verbose diagnostics')
    .option('--quiet', 'errors only')
    // Registered so they appear in --help and are not rejected as unknown.
    // The actual decision is made in main(), before any coloured string exists.
    .option('--no-color', 'disable ANSI colour')
    .option('--color', 'force ANSI colour')
    .showHelpAfterError();

  program
    .command('extract')
    .description('static analysis only — no LLM, no network, no cost')
    .option('-o, --out <path>', 'override output directory')
    .option('--only <ids>', 'comma-separated extractors, e.g. routes,schema')
    .option('--dry-run', 'report what would be generated without writing files', false)
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { out?: string; only?: string; json?: boolean; dryRun?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runExtractCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        ...(commandOptions.out === undefined ? {} : { outDir: commandOptions.out }),
        ...(commandOptions.only === undefined ? {} : { only: commandOptions.only }),
        dryRun: commandOptions.dryRun === true,
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  program
    .command('report')
    .description('coverage summary, counts, and cross-extractor findings')
    .option('--full', 'list every finding item rather than a preview', false)
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { json?: boolean; full?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runReportCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        full: commandOptions.full === true,
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  // Planned commands are registered now so the CLI surface is stable for
  // adapters and CI wiring, and so `--help` documents the roadmap honestly.
  for (const [name, planned] of Object.entries(PLANNED_COMMANDS)) {
    program
      .command(name)
      .description(`${colors().dim(`[${planned.phase}]`)} ${planned.summary}`)
      .allowUnknownOption(true)
      .action(() => runStub(name));
  }

  return program;
}

/** Lowest Node that supports the language features and APIs used here. */
const MINIMUM_NODE_MAJOR = 20;
const MINIMUM_NODE_MINOR = 11;

/**
 * Check the runtime before doing anything.
 *
 * On an older Node the failure would otherwise be a syntax error deep in a
 * dependency, which tells a developer nothing about what to fix.
 */
export function checkNodeVersion(version: string): string | undefined {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  if (match === null) return undefined;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > MINIMUM_NODE_MAJOR) return undefined;
  if (major === MINIMUM_NODE_MAJOR && minor >= MINIMUM_NODE_MINOR) return undefined;

  return (
    `docgen requires Node ${MINIMUM_NODE_MAJOR}.${MINIMUM_NODE_MINOR} or newer, but this is ${version}. ` +
    'Upgrade Node, or run it with npx from a newer runtime.'
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  const versionProblem = checkNodeVersion(process.version);
  if (versionProblem !== undefined) {
    process.stderr.write(`error ${versionProblem}\n`);
    return 1;
  }

  // Must run before buildCli(), which builds coloured command descriptions.
  configureColors(
    resolveColorEnabled({ argv, env: process.env, stream: process.stderr }),
  );

  const program = buildCli();
  try {
    await program.parseAsync([...argv]);
    return 0;
  } catch (error) {
    const logger = createLogger({ level: 'error' });
    if (isDocgenError(error)) {
      logger.error(error.message);
      if (error.file !== undefined) logger.error(`  in ${error.file}`);
      logger.error(`  ${colors().dim(error.remedy)}`);
      return 1;
    }
    logger.error(describeUnknownError(error));
    if (error instanceof Error && error.stack !== undefined) {
      logger.error(colors().dim(error.stack));
    }
    return 1;
  }
}

/**
 * True when this module is the process entrypoint. Compared as resolved
 * filesystem paths rather than URL strings, because a naive URL comparison
 * mismatches on Windows drive letters and separators.
 */
function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return path.resolve(invoked) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Only self-execute when invoked as the binary, so tests can import buildCli().
if (isEntrypoint()) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${describeUnknownError(error)}\n`);
      process.exitCode = 1;
    },
  );
}
