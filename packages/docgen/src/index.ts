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
export {
  EMPTY_GIT_TREE,
  filterGitChanges,
  resolveCommitInfo,
  resolveFileCommitHistory,
  resolveGitChanges,
  resolveGitUserEmail,
  resolveSourceCommit,
} from './util/git.js';
export type {
  CommitInfo,
  FileCommitHistory,
  GitChangeSet,
  GitChangeStatus,
  GitFileChange,
} from './util/git.js';
export { createLogger } from './util/logger.js';
export type { Logger, LogLevel } from './util/logger.js';
export {
  ATOMIC_TEMP_MARKER,
  findStaleAtomicFiles,
  removeAtomicFiles,
  writeFileAtomically,
} from './util/atomic.js';
export type { AtomicWriteOptions } from './util/atomic.js';
export { inspectRepositoryHealth, runDoctorCommand } from './commands/doctor.js';
export type { DoctorCheck, DoctorCheckStatus, DoctorReport } from './commands/doctor.js';
export { runMigrateCommand } from './commands/migrate.js';
export { applyMigrations, inspectMigrations, rollbackMigration } from './migrations/engine.js';
export type { MigrationArtifactKind, MigrationInspection, MigrationStatus } from './migrations/engine.js';
export { MIGRATION_RECEIPT_SCHEMA_VERSION, migrationChangeSchema, migrationReceiptSchema } from './migrations/schema.js';
export type { MigrationChange, MigrationReceipt } from './migrations/schema.js';
export { evaluatePilot, renderPilotReport } from './pilot/evaluate.js';
export type { PilotQuality, PilotReport } from './pilot/evaluate.js';
export { PILOT_MANIFEST_FILE, PILOT_MANIFEST_SCHEMA_VERSION, pilotExpectationSchema, pilotManifestSchema } from './pilot/schema.js';
export type { PilotExpectation, PilotManifest } from './pilot/schema.js';
export { ENGINE_VERSION } from './util/version.js';
export { redactSecrets } from './privacy/redact.js';
export type { RedactionResult } from './privacy/redact.js';
export { scanSupplyChain } from './security/scan.js';
export { buildCycloneDxBom, serialiseCycloneDxBom } from './security/sbom.js';
export type {
  SupplyChainComponent,
  SupplyChainFinding,
  SupplyChainGap,
  SupplyChainReport,
  SupplyChainSeverity,
} from './security/types.js';
export type { CycloneDxBom } from './security/sbom.js';
export {
  runSessionAfterEditCommand,
  runSessionEndCommand,
  runSessionStartCommand,
} from './commands/session.js';
export { handleMcpRequest, runMcpServer } from './mcp/server.js';

export {
  FEATURE_CRITICALITIES,
  FEATURE_RECORD_SCHEMA_VERSION,
  FEATURE_STATUSES,
  featureRecordSchema,
} from './features/schema.js';
export type {
  FeatureCriticality,
  FeatureRecord,
  FeatureStatus,
  StoredFeatureRecord,
} from './features/schema.js';
export {
  loadFeatureRecords,
  serialiseFeatureRecord,
  writeNewFeatureRecord,
} from './features/store.js';
export {
  featureNodeId,
  findFeatureRecord,
  mapFeaturesIntoGraph,
  matchingFeatureNodeIds,
} from './features/graph.js';
export type { FeatureGraphMapping } from './features/graph.js';
export { deriveFeatureCommitHistory } from './features/history.js';
export type { FeatureCommitHistory } from './features/history.js';

export {
  PLAN_RECORD_SCHEMA_VERSION,
  PLAN_STATUSES,
  acceptanceCriterionSchema,
  planTransitionSchema,
  planRecordSchema,
} from './plans/schema.js';
export type { PlanRecord, PlanStatus, StoredPlanRecord } from './plans/schema.js';
export {
  loadPlanRecords,
  serialisePlanRecord,
  updatePlanStatus,
  writeNewPlanRecord,
} from './plans/store.js';
export { mapPlansIntoGraph, planNodeId } from './plans/graph.js';
export { renderTesterHandoff } from './handoff/render.js';
export type { TesterHandoffData, TesterHandoffFeature } from './handoff/render.js';

export {
  CHANGE_KINDS,
  CHANGE_RECORD_SCHEMA_VERSION,
  changeRecordSchema,
} from './changes/schema.js';
export type { ChangeKind, ChangeRecord, StoredChangeRecord } from './changes/schema.js';
export {
  loadChangeRecords,
  serialiseChangeRecord,
  writeNewChangeRecord,
} from './changes/store.js';
export { changeNodeId, mapChangesIntoGraph } from './changes/graph.js';
export { computeGovernanceFiles } from './governance/expected.js';
export { evaluateGovernance, evaluateGovernanceAtRoot } from './governance/evaluate.js';
export type { GovernanceReport, GovernanceViolation, SuppressedGovernanceViolation } from './governance/evaluate.js';
export { GOVERNANCE_EXCEPTION_SCHEMA_VERSION, GOVERNANCE_POLICY_IDS, governanceExceptionSchema, governanceExceptionsSchema } from './governance/schema.js';
export type { GovernanceException, GovernanceExceptions, GovernancePolicyId } from './governance/schema.js';
export { addGovernanceException, loadGovernanceExceptions, serialiseGovernanceExceptions } from './governance/store.js';
export {
  renderChangelog,
  renderFeatureIndex,
  renderFeaturePage,
  renderPlanPage,
} from './governance/render.js';

export { EvidenceGraphBuilder, validateEvidenceGraph } from './graph/builder.js';
export { buildEvidenceGraph } from './graph/from-extraction.js';
export { graphNodeId, graphEdgeId } from './graph/ids.js';
export {
  DEFAULT_FILE_FINGERPRINT_INDEX,
  FILE_FINGERPRINT_SCHEMA_VERSION,
  diffFileFingerprints,
  fingerprintFiles,
  parseFileFingerprints,
  readFileFingerprints,
  serialiseFileFingerprints,
  writeFileFingerprints,
} from './graph/fingerprints.js';
export type {
  FileFingerprint,
  FileFingerprintDiff,
  FileFingerprintManifest,
} from './graph/fingerprints.js';
export { EvidenceGraphIndex } from './graph/query.js';
export { analyzeChangeImpact } from './graph/impact.js';
export type {
  ChangeImpactReport,
  FileChangeImpact,
  ImpactedGraphNode,
} from './graph/impact.js';
export type {
  GraphDirection,
  GraphExplanation,
  GraphNeighbor,
  GraphPath,
  GraphPathOptions,
  GraphSearchOptions,
  GraphTraversalOptions,
} from './graph/query.js';
export { serialiseEvidenceGraph } from './graph/serialize.js';
export { summarizeChangeSurfaces } from './graph/impact-summary.js';
export type { ChangeSurfaceSummary } from './graph/impact-summary.js';
export { mapSurfacesIntoGraph, surfaceNodeId } from './graph/surfaces.js';
export { mapRequirementsIntoGraph, triagedRequirementNodeId } from './requirements/graph.js';
export { enrichGraphWithTypeScriptSymbols } from './graph/symbols.js';
export type { TypeScriptSymbolOptions } from './graph/symbols.js';
export type { PythonSymbolOptions } from './graph/python-symbols.js';
export async function enrichGraphWithPythonSymbols(
  options: import('./graph/python-symbols.js').PythonSymbolOptions,
): Promise<import('./graph/types.js').EvidenceGraph> {
  const implementation = await import('./graph/python-symbols.js');
  return implementation.enrichGraphWithPythonSymbols(options);
}
export {
  applySymbolLanguageAdapters,
  getSymbolLanguageAdapterReports,
  getSymbolLanguageAdapters,
} from './graph/language-adapters.js';
export type {
  SymbolLanguageAdapter,
  SymbolLanguageAdapterContext,
  SymbolLanguageAdapterReport,
  SymbolLanguageAdapterRun,
  SymbolParserBackend,
} from './graph/language-adapters.js';
export {
  DEFAULT_GRAPH_INDEX,
  ensureDefaultGraphCacheIgnored,
  parseEvidenceGraph,
  readEvidenceGraph,
  readEvidenceGraphIfExists,
  writeEvidenceGraph,
} from './graph/store.js';
export type { GraphWriteResult } from './graph/store.js';
export { inventoryLegacyDocuments } from './legacy/inventory.js';
export { mapLegacyInventoryToGraph } from './legacy/mapping.js';
export {
  LEGACY_CLASSIFICATIONS,
  LEGACY_DOCUMENT_OWNERSHIPS,
  LEGACY_EVIDENCE_STATUSES,
  LEGACY_MIGRATION_ACTIONS,
  LEGACY_MIGRATION_SCHEMA_VERSION,
  legacyApprovalTransitionSchema,
  legacyArchiveExecutionSchema,
  legacyClassificationTransitionSchema,
  legacyMigrationManifestSchema,
} from './legacy/schema.js';
export type {
  LegacyClassification,
  LegacyEvidenceStatus,
  LegacyInventoryDocument,
  LegacyMigrationManifest,
} from './legacy/schema.js';
export {
  loadLegacyMigrationManifest,
  serialiseLegacyMigrationManifest,
  writeNewLegacyMigrationManifest,
  writeUpdatedLegacyMigrationManifest,
} from './legacy/store.js';
export {
  LEGACY_OPERATION_PLAN_SCHEMA_VERSION,
  buildLegacyOperationPlans,
  legacyArchivePlanSchema,
  legacyArchiveTarget,
  legacyReplacementPlanSchema,
  writeLegacyOperationPlans,
} from './legacy/plans.js';
export type { LegacyArchivePlan, LegacyReplacementPlan } from './legacy/plans.js';
export {
  GLOBAL_GRAPH_PARTITION,
  GRAPH_PARTITION_SCHEMA_VERSION,
  acceptScopedGraphPartitions,
  mergeGraphPartitions,
  mergeReusableGraphPartitions,
  partitionEvidenceGraph,
  planGraphPartitionRebuild,
  updateGraphPartitions,
} from './graph/partitions.js';
export type {
  GraphPartition,
  GraphPartitionManifest,
  GraphPartitionProfile,
  GraphPartitionRebuildPlan,
  IncrementalPartitionResult,
} from './graph/partitions.js';
export {
  DEFAULT_GRAPH_PARTITION_INDEX,
  parseGraphPartitions,
  readGraphPartitions,
  serialiseGraphPartitions,
  writeGraphPartitions,
} from './graph/partition-store.js';
export {
  EVIDENCE_GRAPH_SCHEMA_VERSION,
  GRAPH_EDGE_KINDS,
  GRAPH_NODE_KINDS,
} from './graph/types.js';
export type {
  EvidenceGraph,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
  GraphProperties,
  GraphPropertyValue,
  GraphProvenance,
  GraphValidationIssue,
} from './graph/types.js';

export * from './types/core.js';
export * from './types/entries.js';
