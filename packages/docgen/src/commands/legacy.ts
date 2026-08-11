import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { serialiseEvidenceGraph } from '../graph/serialize.js';
import { inventoryLegacyDocuments } from '../legacy/inventory.js';
import { mapLegacyInventoryToGraph } from '../legacy/mapping.js';
import {
  buildLegacyOperationPlans,
  legacyArchiveTarget,
  writeLegacyOperationPlans,
} from '../legacy/plans.js';
import {
  LEGACY_MIGRATION_ACTIONS,
  LEGACY_MIGRATION_SCHEMA_VERSION,
  legacyMigrationManifestSchema,
} from '../legacy/schema.js';
import type { LegacyClassification } from '../legacy/schema.js';
import {
  loadLegacyMigrationManifest,
  writeNewLegacyMigrationManifest,
  writeUpdatedLegacyMigrationManifest,
} from '../legacy/store.js';
import { runExtraction } from '../pipeline.js';
import { colors } from '../util/colors.js';
import { DocgenError } from '../util/errors.js';
import { resolveCommitInfo, resolveGitUserEmail } from '../util/git.js';
import type { Logger } from '../util/logger.js';
import { toPosix } from '../util/paths.js';

export interface LegacyInventoryCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  readonly write?: boolean;
  readonly json?: boolean;
  readonly logger: Logger;
  /** Deterministic test/embedding overrides. */
  readonly recordedBy?: string;
  readonly recordedAt?: string;
}

const HUMAN_LEGACY_CLASSIFICATIONS = [
  'current',
  'partial',
  'contradicted',
  'orphaned',
  'unverifiable',
] as const satisfies readonly LegacyClassification[];

export interface LegacyClassifyCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  readonly document: string;
  readonly classification: string;
  readonly reason: string;
  readonly action?: string;
  readonly replacements?: string;
  readonly json?: boolean;
  readonly logger: Logger;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
}

interface LegacyDecisionOptions {
  readonly cwd: string;
  readonly configFile?: string;
  readonly document: string;
  readonly reason?: string;
  readonly json?: boolean;
  readonly logger: Logger;
  readonly actor?: string;
  readonly actedAt?: string;
}

export interface LegacyPlanCommandOptions {
  readonly cwd: string;
  readonly configFile?: string;
  readonly json?: boolean;
  readonly logger: Logger;
}

export type LegacyApproveCommandOptions = LegacyDecisionOptions & { readonly reason: string };
export type LegacyArchiveCommandOptions = LegacyDecisionOptions;

function graphSha256(graph: Parameters<typeof serialiseEvidenceGraph>[0]): string {
  return createHash('sha256').update(serialiseEvidenceGraph(graph)).digest('hex');
}

function humanClassification(value: string): (typeof HUMAN_LEGACY_CLASSIFICATIONS)[number] {
  const classification = HUMAN_LEGACY_CLASSIFICATIONS.find((candidate) => candidate === value);
  if (classification !== undefined) return classification;
  throw new DocgenError({
    code: 'legacy-classification-invalid',
    message: `Legacy classification '${value}' cannot be recorded as a human review decision.`,
    remedy: `Use one of: ${HUMAN_LEGACY_CLASSIFICATIONS.join(', ')}. Exact duplicates are detected by inventory.`,
  });
}

function proposedAction(
  classification: (typeof HUMAN_LEGACY_CLASSIFICATIONS)[number],
  requested: string | undefined,
): (typeof LEGACY_MIGRATION_ACTIONS)[number] {
  if (requested !== undefined) {
    const action = LEGACY_MIGRATION_ACTIONS.find((candidate) => candidate === requested);
    if (action !== undefined) return action;
    throw new DocgenError({
      code: 'legacy-action-invalid',
      message: `Unknown legacy migration action '${requested}'.`,
      remedy: `Use one of: ${LEGACY_MIGRATION_ACTIONS.join(', ')}.`,
    });
  }
  if (classification === 'current') return 'retain';
  if (classification === 'partial' || classification === 'contradicted') return 'replace';
  if (classification === 'orphaned') return 'archive';
  return 'review';
}

function replacementPaths(value: string | undefined): readonly string[] {
  return [...new Set((value ?? '').split(',').map((item) => toPosix(item.trim())).filter(Boolean))].sort();
}

async function rejectSymlinkSegments(root: string, absolute: string): Promise<void> {
  const relative = path.relative(root, absolute);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new DocgenError({
          code: 'legacy-archive-symlink-rejected',
          message: `Archive path contains a symbolic link: ${current}.`,
          remedy: 'Archive only ordinary files through ordinary repository directories.',
          file: current,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Inventory is local static analysis. It never calls a model or mutates legacy documents. */
export async function runLegacyInventoryCommand(options: LegacyInventoryCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const [unmappedInventory, run] = await Promise.all([
    inventoryLegacyDocuments({ root: config.root, outDir: config.outDir }),
    runExtraction({ config, logger: options.logger, includeSymbols: true }),
  ]);
  const inventory = await mapLegacyInventoryToGraph({
    root: config.root,
    inventory: unmappedInventory,
    graph: run.graph,
  });
  let manifestFile: string | undefined;

  if (options.write === true) {
    const commit = await resolveCommitInfo(config.root);
    const manifest = legacyMigrationManifestSchema.parse({
      schemaVersion: LEGACY_MIGRATION_SCHEMA_VERSION,
      createdBy: options.recordedBy ?? (await resolveGitUserEmail(config.root)) ?? 'unknown',
      createdAt: options.recordedAt ?? new Date().toISOString(),
      ...(commit === undefined ? {} : { sourceCommit: commit.sha }),
      evidenceGraphSha256: createHash('sha256')
        .update(serialiseEvidenceGraph(run.graph))
        .digest('hex'),
      policy: 'no-human-document-moves-without-approval',
      documents: inventory.documents
        .filter((document) => document.ownership === 'human-authored')
        .map((document) => ({
          path: document.path,
          sha256: document.sha256,
          classification: document.classification,
          rationale: document.rationale,
          ...(document.duplicateOf === undefined ? {} : { duplicateOf: document.duplicateOf }),
          evidenceStatus: document.evidenceStatus,
          claims: document.claims,
          proposedAction: 'review',
          replacementPaths: [],
          approval: { required: true, status: 'pending' },
        })),
    });
    manifestFile = await writeNewLegacyMigrationManifest(config.root, manifest);
  }

  if (options.json === true) {
    options.logger.output(
      JSON.stringify(
        {
          ...inventory,
          wroteManifest: manifestFile !== undefined,
          ...(manifestFile === undefined ? {} : { manifestFile }),
          mutatedLegacyDocuments: 0,
        },
        null,
        2,
      ),
    );
    return;
  }

  options.logger.heading(`Legacy documentation inventory (${inventory.counts.humanAuthored})`);
  options.logger.info(`  unreviewed   ${inventory.counts.unreviewed}`);
  options.logger.info(`  duplicates   ${inventory.counts.duplicates}`);
  options.logger.info(`  mapped       ${inventory.counts.mapped ?? 0}`);
  options.logger.info(`  partial      ${inventory.counts.partial ?? 0}`);
  options.logger.info(`  unmapped     ${inventory.counts.unmapped ?? 0}`);
  options.logger.info(`  broken refs  ${inventory.counts.orphanedReferences ?? 0}`);
  options.logger.info(`  generated    ${inventory.counts.docgenGenerated} excluded`);
  options.logger.info(`  records      ${inventory.counts.docgenRecords} excluded`);
  for (const document of inventory.documents.filter(
    (candidate) => candidate.ownership === 'human-authored',
  )) {
    options.logger.info(
      `  ${document.classification.padEnd(10)} ${document.path}` +
        (document.duplicateOf === undefined ? '' : colors().dim(` = ${document.duplicateOf}`)),
    );
  }
  if (manifestFile === undefined) {
    options.logger.info(`  ${colors().dim('read-only; pass --write to create the review manifest')}`);
  } else {
    options.logger.info(`  manifest     ${manifestFile}`);
  }
  options.logger.info(`  ${colors().dim('no legacy document was moved, rewritten, or deleted')}`);
}

/** Record an attributed semantic decision; this changes only the manifest. */
export async function runLegacyClassifyCommand(options: LegacyClassifyCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const manifest = await loadLegacyMigrationManifest(config.root);
  if (options.reason.trim().length === 0) {
    throw new DocgenError({
      code: 'legacy-classification-reason-required',
      message: 'A non-empty reason is required for every legacy classification.',
      remedy: 'Pass --reason with the evidence or human decision behind this classification.',
    });
  }
  const requested = toPosix(path.posix.normalize(toPosix(options.document.trim())));
  if (
    requested.length === 0 ||
    requested === '..' ||
    requested.startsWith('../') ||
    path.posix.isAbsolute(requested) ||
    /^[a-zA-Z]:\//.test(requested)
  ) {
    throw new DocgenError({
      code: 'legacy-document-path-invalid',
      message: `Legacy document path '${options.document}' is not repository-relative.`,
      remedy: 'Use the exact path shown by `docgen legacy inventory`, such as docs/old-api.md.',
    });
  }
  const existing = manifest.documents.find((document) => document.path === requested);
  if (existing === undefined) {
    throw new DocgenError({
      code: 'legacy-document-not-in-manifest',
      message: `Legacy document '${requested}' is not present in the migration manifest.`,
      remedy: 'Use a path from docs/.legacy/migration.json or create a fresh inventory manifest.',
      file: requested,
    });
  }

  let contents: string;
  try {
    contents = await fs.readFile(path.join(config.root, requested), 'utf8');
  } catch (cause) {
    throw new DocgenError({
      code: 'legacy-document-changed',
      message: `Legacy document '${requested}' no longer exists or cannot be read.`,
      remedy: 'Re-inventory the repository before recording a decision about changed document bytes.',
      file: requested,
      cause,
    });
  }
  const currentDocumentSha256 = createHash('sha256').update(contents).digest('hex');
  if (currentDocumentSha256 !== existing.sha256) {
    throw new DocgenError({
      code: 'legacy-document-changed',
      message: `Legacy document '${requested}' changed after it was inventoried.`,
      remedy: 'Re-inventory the repository so the decision is attached to the current document bytes.',
      file: requested,
    });
  }

  const run = await runExtraction({ config, logger: options.logger, includeSymbols: true });
  const currentGraphSha256 = graphSha256(run.graph);
  if (currentGraphSha256 !== manifest.evidenceGraphSha256) {
    throw new DocgenError({
      code: 'legacy-evidence-stale',
      message: 'The evidence graph changed after the legacy migration manifest was created.',
      remedy:
        'Preserve the current human-owned manifest as a reviewed revision, then run ' +
        '`docgen legacy inventory --write` to map a new revision against the current code.',
    });
  }

  const classification = humanClassification(options.classification);
  const action = proposedAction(classification, options.action);
  const decidedBy = options.decidedBy ?? (await resolveGitUserEmail(config.root)) ?? 'unknown';
  const decidedAt = options.decidedAt ?? new Date().toISOString();
  const updated = legacyMigrationManifestSchema.parse({
    ...manifest,
    documents: manifest.documents.map((document) =>
      document.path !== requested
        ? document
        : {
            ...document,
            classification,
            rationale: options.reason,
            proposedAction: action,
            replacementPaths: replacementPaths(options.replacements),
            approval: { required: true, status: 'pending' },
            classificationHistory: [
              ...document.classificationHistory,
              {
                from: document.classification,
                to: classification,
                decidedBy,
                decidedAt,
                reason: options.reason,
                evidenceGraphSha256: currentGraphSha256,
              },
            ],
          },
    ),
  });
  const file = await writeUpdatedLegacyMigrationManifest(config.root, updated);
  const result = {
    file,
    document: requested,
    classification,
    proposedAction: action,
    approval: 'pending',
    decidedBy,
    decidedAt,
    mutatedLegacyDocuments: 0,
  };
  if (options.json === true) {
    options.logger.output(JSON.stringify(result, null, 2));
    return;
  }
  options.logger.heading('Legacy document classified');
  options.logger.info(`  document      ${requested}`);
  options.logger.info(`  classification ${classification}`);
  options.logger.info(`  action        ${action} (approval pending)`);
  options.logger.info(`  manifest      ${file}`);
  options.logger.info(`  ${colors().dim('legacy document bytes were not changed')}`);
}

export async function runLegacyPlanCommand(options: LegacyPlanCommandOptions): Promise<void> {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const manifest = await loadLegacyMigrationManifest(config.root);
  const plans = await buildLegacyOperationPlans({ root: config.root, manifest });
  const files = await writeLegacyOperationPlans(config.root, plans);
  const result = {
    ...files,
    replacements: plans.replacement.documents.length,
    archives: plans.archive.documents.length,
    readyForApproval: plans.replacement.documents.filter((document) => document.readyForApproval).length,
    readyForExecution: plans.archive.documents.filter((document) => document.readyForExecution).length,
    mutatedLegacyDocuments: 0,
  };
  if (options.json === true) {
    options.logger.output(JSON.stringify({ ...result, plans }, null, 2));
    return;
  }
  options.logger.heading('Legacy migration plans generated');
  options.logger.info(`  replacements ${result.replacements} (${result.readyForApproval} ready for approval)`);
  options.logger.info(`  archives     ${result.archives} (${result.readyForExecution} ready to execute)`);
  options.logger.info(`  replacement  ${files.replacementFile}`);
  options.logger.info(`  archive      ${files.archiveFile}`);
  options.logger.info(`  ${colors().dim('no legacy document was moved, rewritten, or deleted')}`);
}

async function freshDecisionContext(options: LegacyDecisionOptions) {
  const config = await loadConfig({
    root: options.cwd,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const manifest = await loadLegacyMigrationManifest(config.root);
  const requested = toPosix(path.posix.normalize(toPosix(options.document.trim())));
  const document = manifest.documents.find((candidate) => candidate.path === requested);
  if (document === undefined) {
    throw new DocgenError({
      code: 'legacy-document-not-in-manifest',
      message: `Legacy document '${requested}' is not present in the migration manifest.`,
      remedy: 'Use the exact path recorded in docs/.legacy/migration.json.',
      file: requested,
    });
  }
  let contents: string;
  try {
    contents = await fs.readFile(path.join(config.root, requested), 'utf8');
  } catch (cause) {
    throw new DocgenError({
      code: 'legacy-document-changed',
      message: `Legacy document '${requested}' no longer exists or cannot be read.`,
      remedy: 'Do not approve stale inventory; create a new reviewed manifest revision.',
      file: requested,
      cause,
    });
  }
  const documentSha256 = createHash('sha256').update(contents).digest('hex');
  if (documentSha256 !== document.sha256) {
    throw new DocgenError({
      code: 'legacy-document-changed',
      message: `Legacy document '${requested}' changed after it was inventoried.`,
      remedy: 'Do not approve stale inventory; create a new reviewed manifest revision.',
      file: requested,
    });
  }
  const run = await runExtraction({ config, logger: options.logger, includeSymbols: true });
  const evidenceGraphSha256 = graphSha256(run.graph);
  if (evidenceGraphSha256 !== manifest.evidenceGraphSha256) {
    throw new DocgenError({
      code: 'legacy-evidence-stale',
      message: 'The evidence graph changed after the legacy migration manifest was created.',
      remedy: 'Preserve this manifest revision and create a new inventory before approving operations.',
    });
  }
  return { config, manifest, document, requested, documentSha256, evidenceGraphSha256 };
}

export async function runLegacyApproveCommand(options: LegacyApproveCommandOptions): Promise<void> {
  if (options.reason.trim().length === 0) {
    throw new DocgenError({
      code: 'legacy-approval-reason-required',
      message: 'A non-empty reason is required to approve a legacy migration action.',
      remedy: 'Pass --reason explaining why the proposed replacement or archive is safe.',
    });
  }
  const context = await freshDecisionContext(options);
  if (context.document.classification === 'unreviewed' || context.document.proposedAction === 'review') {
    throw new DocgenError({
      code: 'legacy-action-not-approvable',
      message: `Legacy document '${context.requested}' has not reached an actionable reviewed decision.`,
      remedy: 'Classify it and choose retain, replace, or archive before approval.',
      file: context.requested,
    });
  }
  const plans = await buildLegacyOperationPlans({ root: context.config.root, manifest: context.manifest });
  if (context.document.proposedAction === 'replace') {
    const replacement = plans.replacement.documents.find((document) => document.path === context.requested);
    if (replacement?.readyForApproval !== true) {
      throw new DocgenError({
        code: 'legacy-replacement-not-ready',
        message: `Replacement files for '${context.requested}' are missing or incomplete.`,
        remedy: `Generate every replacement named in the manifest, then run 'docgen legacy plan' to verify them.`,
        file: context.requested,
      });
    }
  }
  const decidedBy = options.actor ?? (await resolveGitUserEmail(context.config.root)) ?? 'unknown';
  const decidedAt = options.actedAt ?? new Date().toISOString();
  const updated = legacyMigrationManifestSchema.parse({
    ...context.manifest,
    documents: context.manifest.documents.map((document) =>
      document.path !== context.requested
        ? document
        : {
            ...document,
            approval: {
              required: true,
              status: 'approved',
              approvedBy: decidedBy,
              approvedAt: decidedAt,
              reason: options.reason,
            },
            approvalHistory: [
              ...document.approvalHistory,
              {
                from: document.approval.status,
                to: 'approved',
                decidedBy,
                decidedAt,
                reason: options.reason,
                evidenceGraphSha256: context.evidenceGraphSha256,
              },
            ],
          },
    ),
  });
  const file = await writeUpdatedLegacyMigrationManifest(context.config.root, updated);
  const result = {
    file,
    document: context.requested,
    action: context.document.proposedAction,
    approval: 'approved',
    approvedBy: decidedBy,
    approvedAt: decidedAt,
    mutatedLegacyDocuments: 0,
  };
  if (options.json === true) options.logger.output(JSON.stringify(result, null, 2));
  else {
    options.logger.heading('Legacy migration action approved');
    options.logger.info(`  document  ${context.requested}`);
    options.logger.info(`  action    ${context.document.proposedAction}`);
    options.logger.info(`  manifest  ${file}`);
    options.logger.info(`  ${colors().dim('approval recorded; no document was moved')}`);
  }
}

export async function runLegacyArchiveCommand(options: LegacyArchiveCommandOptions): Promise<void> {
  const context = await freshDecisionContext(options);
  if (
    context.document.approval.status !== 'approved' ||
    (context.document.proposedAction !== 'archive' && context.document.proposedAction !== 'replace')
  ) {
    throw new DocgenError({
      code: 'legacy-archive-not-approved',
      message: `Legacy document '${context.requested}' does not have approval for archive execution.`,
      remedy: 'Classify the document, generate the plans, and record approval before archiving.',
      file: context.requested,
    });
  }
  const plans = await buildLegacyOperationPlans({ root: context.config.root, manifest: context.manifest });
  const operation = plans.archive.documents.find((document) => document.path === context.requested);
  if (operation?.readyForExecution !== true) {
    throw new DocgenError({
      code: 'legacy-archive-not-ready',
      message: `Archive operation for '${context.requested}' is not ready.`,
      remedy: 'Ensure approved replacement files exist and regenerate the legacy operation plans.',
      file: context.requested,
    });
  }
  const target = legacyArchiveTarget(context.requested);
  const sourceAbsolute = path.resolve(context.config.root, context.requested);
  const targetAbsolute = path.resolve(context.config.root, target);
  const rootAbsolute = path.resolve(context.config.root);
  for (const absolute of [sourceAbsolute, targetAbsolute]) {
    const relative = path.relative(rootAbsolute, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new DocgenError({
        code: 'legacy-archive-path-invalid',
        message: `Archive path escapes the repository: ${absolute}.`,
        remedy: 'Use only repository-relative document paths from the migration manifest.',
      });
    }
  }
  await rejectSymlinkSegments(rootAbsolute, sourceAbsolute);
  await rejectSymlinkSegments(rootAbsolute, path.dirname(targetAbsolute));
  const sourceStat = await fs.lstat(sourceAbsolute);
  if (!sourceStat.isFile()) {
    throw new DocgenError({
      code: 'legacy-archive-source-not-file',
      message: `Legacy archive source is not an ordinary file: ${context.requested}.`,
      remedy: 'Archive only regular human-authored document files.',
      file: context.requested,
    });
  }
  try {
    await fs.lstat(targetAbsolute);
    throw new DocgenError({
      code: 'legacy-archive-target-exists',
      message: `Archive target already exists at ${target}.`,
      remedy: 'Resolve the existing archive deliberately; Docgen never overwrites archived human prose.',
      file: target,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const executedBy = options.actor ?? (await resolveGitUserEmail(context.config.root)) ?? 'unknown';
  const executedAt = options.actedAt ?? new Date().toISOString();
  const updated = legacyMigrationManifestSchema.parse({
    ...context.manifest,
    documents: context.manifest.documents.map((document) =>
      document.path !== context.requested
        ? document
        : {
            ...document,
            execution: {
              status: 'archived',
              source: context.requested,
              target,
              sourceSha256: context.documentSha256,
              executedBy,
              executedAt,
            },
          },
    ),
  });
  await fs.mkdir(path.dirname(targetAbsolute), { recursive: true });
  await fs.rename(sourceAbsolute, targetAbsolute);
  try {
    await writeUpdatedLegacyMigrationManifest(context.config.root, updated);
  } catch (error) {
    try {
      await fs.mkdir(path.dirname(sourceAbsolute), { recursive: true });
      await fs.rename(targetAbsolute, sourceAbsolute);
    } catch (rollbackError) {
      throw new DocgenError({
        code: 'legacy-archive-rollback-failed',
        message: `Archived ${context.requested} to ${target}, but manifest update and rollback both failed.`,
        remedy: `Restore ${target} to ${context.requested} manually and preserve both error details.`,
        file: target,
        cause: { updateError: error, rollbackError },
      });
    }
    throw error;
  }
  const result = {
    document: context.requested,
    target,
    sourceSha256: context.documentSha256,
    executedBy,
    executedAt,
    recoverable: true,
  };
  if (options.json === true) options.logger.output(JSON.stringify(result, null, 2));
  else {
    options.logger.heading('Legacy document archived');
    options.logger.info(`  source    ${context.requested}`);
    options.logger.info(`  target    ${target}`);
    options.logger.info(`  manifest  docs/.legacy/migration.json`);
    options.logger.info(`  ${colors().dim('recoverable move; no document was deleted')}`);
  }
}
