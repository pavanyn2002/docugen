#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { colors, configureColors, resolveColorEnabled } from './util/colors.js';
import { runExtractCommand } from './commands/extract.js';
import { runReportCommand } from './commands/report.js';
import { runBootstrapCommand } from './commands/bootstrap.js';
import { runAskCommand } from './commands/ask.js';
import { runAnswerCommand } from './commands/answer.js';
import { runInitCommand } from './commands/init.js';
import { runTriageCommand } from './commands/triage.js';
import { runSyncCommand } from './commands/sync.js';
import { runCheckCommand } from './commands/check.js';
import { runTraceCommand } from './commands/trace.js';
import { runStatusCommand } from './commands/status.js';
import { runFleetCommand } from './commands/fleet.js';
import { runIndexGraphCommand } from './commands/index-graph.js';
import { runImpactCommand } from './commands/impact.js';
import {
  runFeatureAddCommand,
  runFeatureListCommand,
  runFeatureShowCommand,
} from './commands/feature.js';
import {
  runPlanCreateCommand,
  runPlanListCommand,
  runPlanShowCommand,
  runPlanStatusCommand,
} from './commands/plan.js';
import { runHandoffCommand } from './commands/handoff.js';
import { runChangeRecordCommand } from './commands/change.js';
import {
  runLegacyApproveCommand,
  runLegacyArchiveCommand,
  runLegacyClassifyCommand,
  runLegacyInventoryCommand,
  runLegacyPlanCommand,
} from './commands/legacy.js';
import {
  runGraphExplainCommand,
  runGraphPathCommand,
  runGraphSearchCommand,
} from './commands/query-graph.js';
import { createLogger } from './util/logger.js';
import type { LogLevel } from './util/logger.js';
import { describeUnknownError, isDocgenError } from './util/errors.js';
import { ENGINE_VERSION } from './util/version.js';
import { runSessionAfterEditCommand, runSessionEndCommand, runSessionStartCommand } from './commands/session.js';
import { runMcpServer } from './mcp/server.js';
import {
  runPolicyCheckCommand,
  runPolicyExceptionAddCommand,
  runPolicyExceptionListCommand,
} from './commands/policy.js';
import { runSecuritySbomCommand, runSecurityScanCommand } from './commands/security.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runMigrateCommand } from './commands/migrate.js';
import { runPilotCommand } from './commands/pilot.js';

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

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
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
    .command('mcp')
    .description('serve graph, impact, plan, question, and handoff tools over MCP stdio')
    .action(async () => {
      const globals = program.opts<GlobalOptions>();
      await runMcpServer({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
      });
    });

  const session = program
    .command('session')
    .description('run the common documentation lifecycle used by every coding agent');

  session.command('start')
    .description('refresh evidence and expose active plans and open questions')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runSessionStartCommand({ cwd: globals.cwd ?? process.cwd(), ...(globals.config === undefined ? {} : { configFile: globals.config }), json: commandOptions.json === true, logger: createLogger({ level: resolveLogLevel(globals) }) });
    });

  session.command('after-edit')
    .description('refresh the incremental graph and report Git change impact')
    .option('--base <ref>', 'Git revision to compare against', 'HEAD')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { base?: string; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runSessionAfterEditCommand({ cwd: globals.cwd ?? process.cwd(), ...(globals.config === undefined ? {} : { configFile: globals.config }), ...(commandOptions.base === undefined ? {} : { base: commandOptions.base }), json: commandOptions.json === true, logger: createLogger({ level: resolveLogLevel(globals) }) });
    });

  session.command('end')
    .description('sync docs, generate the tester handoff, and enforce the gate')
    .option('--base <ref>', 'Git revision to compare against', 'HEAD')
    .option('--strict', 'also fail on unanswered questions or untriaged answers', false)
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { base?: string; strict?: boolean; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runSessionEndCommand({ cwd: globals.cwd ?? process.cwd(), ...(globals.config === undefined ? {} : { configFile: globals.config }), ...(commandOptions.base === undefined ? {} : { base: commandOptions.base }), strict: commandOptions.strict === true, json: commandOptions.json === true, logger: createLogger({ level: resolveLogLevel(globals) }) });
    });

  program
    .command('index')
    .description('build the local AST evidence graph - no LLM, no network, no cost')
    .option('-o, --out <path>', 'repo-relative graph index path')
    .option('--no-symbols', 'omit function, class, method, and call relationships')
    .option('--dry-run', 'build and validate the graph without writing the index', false)
    .option('--json', 'machine-readable output on stdout', false)
    .action(
      async (commandOptions: {
        out?: string;
        symbols?: boolean;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        const globals = program.opts<GlobalOptions>();
        await runIndexGraphCommand({
          cwd: globals.cwd ?? process.cwd(),
          ...(globals.config === undefined ? {} : { configFile: globals.config }),
          ...(commandOptions.out === undefined ? {} : { out: commandOptions.out }),
          symbols: commandOptions.symbols !== false,
          dryRun: commandOptions.dryRun === true,
          json: commandOptions.json === true,
          logger: createLogger({ level: resolveLogLevel(globals) }),
        });
      },
    );

  program
    .command('query')
    .argument('<text>', 'text to match against graph node ids and labels')
    .description('search the live evidence graph - rebuilds locally, no LLM')
    .option('--kinds <kinds>', 'comma-separated node kinds')
    .option('--limit <n>', 'maximum results', (value: string) => Number(value), 50)
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (query: string, commandOptions: { kinds?: string; limit?: number; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runGraphSearchCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        text: query,
        ...(commandOptions.kinds === undefined ? {} : { kinds: commandOptions.kinds }),
        ...(commandOptions.limit === undefined ? {} : { limit: commandOptions.limit }),
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  program
    .command('explain')
    .argument('<node-id>', 'exact graph node id')
    .description('show a graph node, its evidence, and direct relationships')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (id: string, commandOptions: { json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runGraphExplainCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        id,
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  program
    .command('path')
    .argument('<from>', 'starting graph node id')
    .argument('<to>', 'target graph node id')
    .description('find a deterministic shortest path through the live evidence graph')
    .option('--direction <direction>', 'outgoing, incoming, or both', 'outgoing')
    .option('--edge-kinds <kinds>', 'comma-separated relationship kinds')
    .option('--max-depth <n>', 'maximum relationships to cross', (value: string) => Number(value), 12)
    .option('--json', 'machine-readable output on stdout', false)
    .action(
      async (
        from: string,
        to: string,
        commandOptions: { direction?: string; edgeKinds?: string; maxDepth?: number; json?: boolean },
      ) => {
        const globals = program.opts<GlobalOptions>();
        await runGraphPathCommand({
          cwd: globals.cwd ?? process.cwd(),
          ...(globals.config === undefined ? {} : { configFile: globals.config }),
          from,
          to,
          ...(commandOptions.direction === undefined ? {} : { direction: commandOptions.direction }),
          ...(commandOptions.edgeKinds === undefined ? {} : { edgeKinds: commandOptions.edgeKinds }),
          ...(commandOptions.maxDepth === undefined ? {} : { maxDepth: commandOptions.maxDepth }),
          json: commandOptions.json === true,
          logger: createLogger({ level: resolveLogLevel(globals) }),
        });
      },
    );

  program
    .command('impact')
    .description('trace Git changes to affected graph entities - no LLM or network')
    .option('--base <ref>', 'Git revision to compare against', 'HEAD')
    .option('--max-depth <n>', 'maximum incoming relationships to cross', (value: string) => Number(value), 6)
    .option('--limit <n>', 'maximum impacted entities shown per file', (value: string) => Number(value), 50)
    .option('--json', 'machine-readable output on stdout', false)
    .action(
      async (commandOptions: { base?: string; maxDepth?: number; limit?: number; json?: boolean }) => {
        const globals = program.opts<GlobalOptions>();
        await runImpactCommand({
          cwd: globals.cwd ?? process.cwd(),
          ...(globals.config === undefined ? {} : { configFile: globals.config }),
          ...(commandOptions.base === undefined ? {} : { base: commandOptions.base }),
          ...(commandOptions.maxDepth === undefined ? {} : { maxDepth: commandOptions.maxDepth }),
          ...(commandOptions.limit === undefined ? {} : { limit: commandOptions.limit }),
          json: commandOptions.json === true,
          logger: createLogger({ level: resolveLogLevel(globals) }),
        });
      },
    );

  const feature = program
    .command('feature')
    .description('manage stable, human-owned feature identities and code selectors');

  feature
    .command('add')
    .argument('<id>', 'stable lowercase kebab-case feature id')
    .description('create a new attributed feature record without overwriting existing identity')
    .requiredOption('--title <title>', 'human-readable feature title')
    .option('--description <text>', 'feature purpose or scope')
    .option('--aliases <ids>', 'comma-separated previous feature ids')
    .option('--files <globs>', 'comma-separated repo-relative file globs')
    .option('--nodes <ids>', 'comma-separated exact graph node ids')
    .option('--owners <owners>', 'comma-separated owner emails or team names')
    .option('--status <status>', 'planned, active, deprecated, or retired', 'active')
    .option('--criticality <level>', 'low, medium, high, or critical', 'medium')
    .option('--json', 'machine-readable output on stdout', false)
    .action(
      async (
        id: string,
        commandOptions: {
          title: string;
          description?: string;
          aliases?: string;
          files?: string;
          nodes?: string;
          owners?: string;
          status?: string;
          criticality?: string;
          json?: boolean;
        },
      ) => {
        const globals = program.opts<GlobalOptions>();
        await runFeatureAddCommand({
          cwd: globals.cwd ?? process.cwd(),
          ...(globals.config === undefined ? {} : { configFile: globals.config }),
          id,
          title: commandOptions.title,
          ...(commandOptions.description === undefined ? {} : { description: commandOptions.description }),
          ...(commandOptions.aliases === undefined ? {} : { aliases: commandOptions.aliases }),
          ...(commandOptions.files === undefined ? {} : { files: commandOptions.files }),
          ...(commandOptions.nodes === undefined ? {} : { nodes: commandOptions.nodes }),
          ...(commandOptions.owners === undefined ? {} : { owners: commandOptions.owners }),
          ...(commandOptions.status === undefined ? {} : { status: commandOptions.status }),
          ...(commandOptions.criticality === undefined ? {} : { criticality: commandOptions.criticality }),
          json: commandOptions.json === true,
          logger: createLogger({ level: resolveLogLevel(globals) }),
        });
      },
    );

  feature
    .command('list')
    .description('list registered stable features')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runFeatureListCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  feature
    .command('show')
    .argument('<id-or-alias>', 'stable feature id or a registered previous id')
    .description('show feature selectors, graph membership, and Git-derived dates')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (id: string, commandOptions: { json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runFeatureShowCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        id,
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  const plan = program
    .command('plan')
    .description('manage human-owned implementation plans and stable acceptance criteria');

  plan
    .command('create')
    .argument('<id>', 'stable lowercase kebab-case plan id')
    .description('create an attributed plan linked to a registered feature')
    .requiredOption('--feature <id>', 'feature id or registered alias')
    .requiredOption('--title <title>', 'human-readable plan title')
    .requiredOption('--summary <text>', 'intended change and scope')
    .option('--status <status>', 'draft, approved, in-progress, completed, or cancelled', 'draft')
    .option('--acceptance <text>', 'acceptance criterion; repeat for multiple', collectOption, [])
    .option('--risk <text>', 'known risk; repeat for multiple', collectOption, [])
    .option('--test-note <text>', 'tester context; repeat for multiple', collectOption, [])
    .option('--json', 'machine-readable output on stdout', false)
    .action(
      async (
        id: string,
        commandOptions: {
          feature: string;
          title: string;
          summary: string;
          status?: string;
          acceptance?: string[];
          risk?: string[];
          testNote?: string[];
          json?: boolean;
        },
      ) => {
        const globals = program.opts<GlobalOptions>();
        await runPlanCreateCommand({
          cwd: globals.cwd ?? process.cwd(),
          ...(globals.config === undefined ? {} : { configFile: globals.config }),
          id,
          feature: commandOptions.feature,
          title: commandOptions.title,
          summary: commandOptions.summary,
          ...(commandOptions.status === undefined ? {} : { status: commandOptions.status }),
          ...(commandOptions.acceptance === undefined ? {} : { acceptance: commandOptions.acceptance }),
          ...(commandOptions.risk === undefined ? {} : { risks: commandOptions.risk }),
          ...(commandOptions.testNote === undefined ? {} : { testNotes: commandOptions.testNote }),
          json: commandOptions.json === true,
          logger: createLogger({ level: resolveLogLevel(globals) }),
        });
      },
    );

  plan
    .command('list')
    .description('list recorded plans')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runPlanListCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  plan
    .command('show')
    .argument('<id>', 'stable plan id')
    .description('show plan scope, acceptance criteria, risks, and tester notes')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (id: string, commandOptions: { json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runPlanShowCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        id,
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  plan
    .command('status')
    .argument('<id>', 'stable plan id')
    .argument('<status>', 'approved, in-progress, completed, or cancelled')
    .description('record an attributed, validated plan lifecycle transition')
    .option('--note <text>', 'reason or release context for this transition')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (id: string, status: string, commandOptions: { note?: string; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runPlanStatusCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        id,
        status,
        ...(commandOptions.note === undefined ? {} : { note: commandOptions.note }),
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  program
    .command('handoff')
    .description('generate a tester-ready handoff from Git, graph, features, and plans')
    .option('--base <ref>', 'Git revision to compare against', 'HEAD')
    .option('-o, --out <path>', 'repo-relative Markdown output path')
    .option('--max-depth <n>', 'maximum impact relationships to traverse', (value: string) => Number(value), 6)
    .option('--dry-run', 'build the handoff without writing it', false)
    .option('--json', 'machine-readable summary on stdout', false)
    .action(
      async (commandOptions: {
        base?: string;
        out?: string;
        maxDepth?: number;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        const globals = program.opts<GlobalOptions>();
        await runHandoffCommand({
          cwd: globals.cwd ?? process.cwd(),
          ...(globals.config === undefined ? {} : { configFile: globals.config }),
          ...(commandOptions.base === undefined ? {} : { base: commandOptions.base }),
          ...(commandOptions.out === undefined ? {} : { out: commandOptions.out }),
          ...(commandOptions.maxDepth === undefined ? {} : { maxDepth: commandOptions.maxDepth }),
          dryRun: commandOptions.dryRun === true,
          json: commandOptions.json === true,
          logger: createLogger({ level: resolveLogLevel(globals) }),
        });
      },
    );

  const change = program
    .command('change')
    .description('record immutable, attributed feature changes from a Git comparison');

  change
    .command('record')
    .argument('<id>', 'stable lowercase kebab-case change id')
    .description('snapshot changed files and link them to governed features and plans')
    .requiredOption('--summary <text>', 'human description of the delivered change')
    .requiredOption('--features <ids>', 'comma-separated feature ids or aliases')
    .option('--plans <ids>', 'comma-separated plan ids')
    .option('--kind <kind>', 'feature, fix, refactor, breaking, or docs', 'feature')
    .option('--base <ref>', 'Git revision containing the pre-change state', 'HEAD')
    .option('--json', 'machine-readable output on stdout', false)
    .action(
      async (
        id: string,
        commandOptions: {
          summary: string;
          features: string;
          plans?: string;
          kind?: string;
          base?: string;
          json?: boolean;
        },
      ) => {
        const globals = program.opts<GlobalOptions>();
        await runChangeRecordCommand({
          cwd: globals.cwd ?? process.cwd(),
          ...(globals.config === undefined ? {} : { configFile: globals.config }),
          id,
          summary: commandOptions.summary,
          features: commandOptions.features,
          ...(commandOptions.plans === undefined ? {} : { plans: commandOptions.plans }),
          ...(commandOptions.kind === undefined ? {} : { kind: commandOptions.kind }),
          ...(commandOptions.base === undefined ? {} : { base: commandOptions.base }),
          json: commandOptions.json === true,
          logger: createLogger({ level: resolveLogLevel(globals) }),
        });
      },
    );

  const legacy = program
    .command('legacy')
    .description('inventory and migrate stale documentation without trusting or deleting it');

  legacy
    .command('inventory')
    .description('inventory legacy documents; exact duplicates only are classified automatically')
    .option('--write', 'create the human-review migration manifest', false)
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { write?: boolean; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runLegacyInventoryCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        write: commandOptions.write === true,
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  legacy
    .command('classify')
    .description('record an attributed semantic classification in the migration manifest')
    .argument('<document>', 'repo-relative path shown by legacy inventory')
    .argument('<classification>', 'current, partial, contradicted, orphaned, or unverifiable')
    .requiredOption('--reason <text>', 'evidence or human decision supporting the classification')
    .option('--action <action>', 'review, retain, replace, or archive')
    .option('--replacements <paths>', 'comma-separated generated replacement paths')
    .option('--json', 'machine-readable output on stdout', false)
    .action(
      async (
        document: string,
        classification: string,
        commandOptions: { reason: string; action?: string; replacements?: string; json?: boolean },
      ) => {
        const globals = program.opts<GlobalOptions>();
        await runLegacyClassifyCommand({
          cwd: globals.cwd ?? process.cwd(),
          ...(globals.config === undefined ? {} : { configFile: globals.config }),
          document,
          classification,
          reason: commandOptions.reason,
          ...(commandOptions.action === undefined ? {} : { action: commandOptions.action }),
          ...(commandOptions.replacements === undefined
            ? {}
            : { replacements: commandOptions.replacements }),
          json: commandOptions.json === true,
          logger: createLogger({ level: resolveLogLevel(globals) }),
        });
      },
    );

  legacy
    .command('plan')
    .description('generate replacement and archive plans from reviewed migration decisions')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runLegacyPlanCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  legacy
    .command('approve')
    .description('approve one reviewed replacement or archive action without executing it')
    .argument('<document>', 'repo-relative path in the migration manifest')
    .requiredOption('--reason <text>', 'why this operation is safe to execute')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (document: string, commandOptions: { reason: string; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runLegacyApproveCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        document,
        reason: commandOptions.reason,
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  legacy
    .command('archive')
    .description('move one approved document into the recoverable repository archive')
    .argument('<document>', 'repo-relative approved document path')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (document: string, commandOptions: { json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runLegacyArchiveCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        document,
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

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

  program
    .command('bootstrap')
    .description('infer a feature card per surface using an LLM — this one costs money')
    .option('--force', 'regenerate every surface, even unchanged ones', false)
    .option('--limit <n>', 'only process the first N surfaces', (value: string) => Number(value))
    .option('--dry-run', 'report what would run, and which backends are available', false)
    .action(async (commandOptions: { force?: boolean; limit?: number; dryRun?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runBootstrapCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        ...(commandOptions.limit === undefined ? {} : { limit: commandOptions.limit }),
        force: commandOptions.force === true,
        dryRun: commandOptions.dryRun === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  program
    .command('ask')
    .description('list the open questions the model could not answer')
    .option('--mine', 'only questions on code you last touched', false)
    .option('--surface <slug>', 'only questions for one surface')
    .option('--limit <n>', 'show at most N questions', (value: string) => Number(value))
    .option('--json', 'machine-readable output on stdout', false)
    .action(
      async (commandOptions: { mine?: boolean; surface?: string; limit?: number; json?: boolean }) => {
        const globals = program.opts<GlobalOptions>();
        await runAskCommand({
          cwd: globals.cwd ?? process.cwd(),
          ...(globals.config === undefined ? {} : { configFile: globals.config }),
          ...(commandOptions.surface === undefined ? {} : { surface: commandOptions.surface }),
          ...(commandOptions.limit === undefined ? {} : { limit: commandOptions.limit }),
          mine: commandOptions.mine === true,
          json: commandOptions.json === true,
          logger: createLogger({ level: resolveLogLevel(globals) }),
        });
      },
    );

  program
    .command('answer')
    .argument('<surface>', 'surface slug, as shown by `docgen ask`')
    .argument('<question-id>', 'question id, as shown by `docgen ask`')
    .argument('<answer>', 'the answer, or the number of one of the offered options')
    .description('record an answer as ground truth — this is what makes a claim verified')
    .option('--note <text>', 'additional context to record alongside the answer')
    .action(
      async (
        surface: string,
        questionId: string,
        answer: string,
        commandOptions: { note?: string },
      ) => {
        const globals = program.opts<GlobalOptions>();
        await runAnswerCommand({
          cwd: globals.cwd ?? process.cwd(),
          ...(globals.config === undefined ? {} : { configFile: globals.config }),
          ...(commandOptions.note === undefined ? {} : { note: commandOptions.note }),
          surface,
          questionId,
          answer,
          logger: createLogger({ level: resolveLogLevel(globals) }),
        });
      },
    );

  program
    .command('sync')
    .description('bring every generated file up to date — no model, no cost')
    .option('--dry-run', 'report what would change without writing', false)
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { dryRun?: boolean; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runSyncCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        dryRun: commandOptions.dryRun === true,
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  program
    .command('check')
    .description('CI gate: fail when the committed documentation is out of date')
    .option('--base <ref>', 'Git revision used by change-scoped governance policies')
    .option('--as-of <timestamp>', 'override policy exception evaluation time (ISO-8601)')
    .option('--strict', 'also fail on unanswered questions and untriaged answers', false)
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { base?: string; asOf?: string; strict?: boolean; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runCheckCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        ...(commandOptions.base === undefined ? {} : { base: commandOptions.base }),
        ...(commandOptions.asOf === undefined ? {} : { asOf: commandOptions.asOf }),
        strict: commandOptions.strict === true,
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  program
    .command('doctor')
    .description('diagnose configuration, schema, cache, Git, and interrupted-write health')
    .option('--fix', 'remove stale Docgen temporary files; never modify governed records', false)
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { fix?: boolean; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runDoctorCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        fix: commandOptions.fix === true,
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  program
    .command('migrate')
    .description('explicitly upgrade governed artifact schemas with backups and rollback')
    .option('--dry-run', 'inspect compatibility without modifying artifacts', false)
    .option('--rollback <id>', 'restore one migration while migrated bytes are unchanged')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { dryRun?: boolean; rollback?: string; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runMigrateCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(commandOptions.rollback === undefined ? {} : { rollback: commandOptions.rollback }),
        dryRun: commandOptions.dryRun === true,
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  program
    .command('pilot')
    .description('compare extraction results with attributed human-reviewed expectations')
    .option('--manifest <path>', 'pilot expectation manifest (default: docgen.pilot.json)')
    .option('-o, --out <path>', 'write a deterministic Markdown report')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { manifest?: string; out?: string; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runPilotCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(commandOptions.manifest === undefined ? {} : { manifest: commandOptions.manifest }),
        ...(commandOptions.out === undefined ? {} : { out: commandOptions.out }),
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  const security = program
    .command('security')
    .description('inspect dependency reproducibility and generate an offline SBOM');
  security.command('scan')
    .description('scan manifests and lockfiles for deterministic supply-chain risks')
    .option('--strict', 'fail on any finding or unsupported dependency format', false)
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { strict?: boolean; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runSecurityScanCommand({
        cwd: globals.cwd ?? process.cwd(),
        strict: commandOptions.strict === true,
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });
  security.command('sbom')
    .description('generate a deterministic CycloneDX 1.6 dependency inventory')
    .option('-o, --out <path>', `output path (default: docs/.security/sbom.cdx.json)`)
    .option('--dry-run', 'build the SBOM without writing it', false)
    .option('--json', 'print the SBOM to stdout instead of writing it', false)
    .action(async (commandOptions: { out?: string; dryRun?: boolean; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runSecuritySbomCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(commandOptions.out === undefined ? {} : { out: commandOptions.out }),
        dryRun: commandOptions.dryRun === true,
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  const policy = program.command('policy').description('evaluate deterministic governance policies and exceptions');
  policy.command('check')
    .description('evaluate configured policy rules without checking generated-file drift')
    .option('--base <ref>', 'Git revision used by change-scoped policies')
    .option('--as-of <timestamp>', 'override exception evaluation time (ISO-8601)')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { base?: string; asOf?: string; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runPolicyCheckCommand({ cwd: globals.cwd ?? process.cwd(), ...(globals.config === undefined ? {} : { configFile: globals.config }), ...(commandOptions.base === undefined ? {} : { base: commandOptions.base }), ...(commandOptions.asOf === undefined ? {} : { asOf: commandOptions.asOf }), json: commandOptions.json === true, logger: createLogger({ level: resolveLogLevel(globals) }) });
    });
  const exception = policy.command('exception').description('manage explicit time-bounded policy exceptions');
  exception.command('list')
    .description('list active and expired governance exceptions')
    .option('--as-of <timestamp>', 'override exception evaluation time (ISO-8601)')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { asOf?: string; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runPolicyExceptionListCommand({ cwd: globals.cwd ?? process.cwd(), ...(globals.config === undefined ? {} : { configFile: globals.config }), ...(commandOptions.asOf === undefined ? {} : { asOf: commandOptions.asOf }), json: commandOptions.json === true, logger: createLogger({ level: resolveLogLevel(globals) }) });
    });
  exception.command('add')
    .argument('<id>', 'immutable lowercase kebab-case exception id')
    .description('record an owned exception with a mandatory expiry')
    .requiredOption('--policy <id>', 'policy id')
    .option('--subject <id>', 'specific feature, requirement, or repository subject')
    .requiredOption('--owner <identity>', 'person accountable for resolving the exception')
    .requiredOption('--reason <text>', 'why the policy cannot be satisfied yet')
    .requiredOption('--expires <timestamp>', 'future ISO-8601 expiry')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (id: string, commandOptions: { policy: string; subject?: string; owner: string; reason: string; expires: string; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runPolicyExceptionAddCommand({ cwd: globals.cwd ?? process.cwd(), ...(globals.config === undefined ? {} : { configFile: globals.config }), id, policy: commandOptions.policy, ...(commandOptions.subject === undefined ? {} : { subject: commandOptions.subject }), owner: commandOptions.owner, reason: commandOptions.reason, expiresAt: commandOptions.expires, json: commandOptions.json === true, logger: createLogger({ level: resolveLogLevel(globals) }) });
    });

  program
    .command('triage')
    .argument('[surface]', 'surface slug — omit for an interactive walk')
    .argument('[question-id]', 'question id, as shown by `docgen triage --list`')
    .argument('[kind]', 'requirement | bug | decision | context')
    .description('decide what each answer means: intended behaviour, a defect, or a decision')
    .option('--list', 'show what is waiting and change nothing', false)
    .option('--json', 'machine-readable output on stdout', false)
    .option('--note <text>', 'additional context to record with the classification')
    .action(
      async (
        surface: string | undefined,
        questionId: string | undefined,
        kind: string | undefined,
        commandOptions: { list?: boolean; json?: boolean; note?: string },
      ) => {
        const globals = program.opts<GlobalOptions>();
        await runTriageCommand({
          cwd: globals.cwd ?? process.cwd(),
          ...(globals.config === undefined ? {} : { configFile: globals.config }),
          ...(surface === undefined ? {} : { surface }),
          ...(questionId === undefined ? {} : { questionId }),
          ...(kind === undefined ? {} : { kind }),
          ...(commandOptions.note === undefined ? {} : { note: commandOptions.note }),
          list: commandOptions.list === true,
          json: commandOptions.json === true,
          logger: createLogger({ level: resolveLogLevel(globals) }),
        });
      },
    );

  program
    .command('trace')
    .description('link requirements to the tests that check them, and report what is not covered')
    .option('--strict', 'exit non-zero when any traceability gap is non-empty', false)
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { strict?: boolean; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runTraceCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        strict: commandOptions.strict === true,
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  program
    .command('status')
    .description('documentation health for this repo, in one screen — no model, no cost')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (commandOptions: { json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runStatusCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  program
    .command('fleet')
    .argument('<paths...>', 'repository roots to inspect')
    .description('one dashboard across every repository docgen is installed in')
    .option('-o, --out <path>', 'where to write the dashboard (default: docgen-fleet.md)')
    .option('--json', 'machine-readable output on stdout', false)
    .action(async (paths: string[], commandOptions: { out?: string; json?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runFleetCommand({
        paths,
        ...(commandOptions.out === undefined ? {} : { out: commandOptions.out }),
        json: commandOptions.json === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

  program
    .command('init')
    .description('install agent skills, MCP configuration, and the CI integration')
    .option('--all', 'install every adapter, not only the ones this repo uses', false)
    .option('--hooks', 'install and activate the opt-in Git pre-push check', false)
    .action(async (commandOptions: { all?: boolean; hooks?: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      await runInitCommand({
        cwd: globals.cwd ?? process.cwd(),
        ...(globals.config === undefined ? {} : { configFile: globals.config }),
        all: commandOptions.all === true,
        hooks: commandOptions.hooks === true,
        logger: createLogger({ level: resolveLogLevel(globals) }),
      });
    });

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
