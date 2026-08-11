import fs from 'node:fs/promises';
import path from 'node:path';
import { loadAnswers } from '../questions/store.js';
import { loadConfig } from '../config/load.js';
import type { ResolvedConfig } from '../config/schema.js';
import { loadFeatureRecords } from '../features/store.js';
import { featureNodeId } from '../features/graph.js';
import { analyzeChangeImpact } from '../graph/impact.js';
import { DEFAULT_GRAPH_INDEX, readEvidenceGraphIfExists } from '../graph/store.js';
import type { EvidenceGraph } from '../graph/types.js';
import { DEFAULT_HANDOFF_FILE } from '../commands/handoff.js';
import { loadCards } from '../infer/store.js';
import type { FeatureCard } from '../infer/types.js';
import { loadPlanRecords } from '../plans/store.js';
import { loadRequirements } from '../requirements/store.js';
import { buildMatrix } from '../trace/matrix.js';
import { scanTestReferences } from '../trace/scan.js';
import { filterGitChanges, resolveGitChanges } from '../util/git.js';
import { compareStrings } from '../util/sort.js';
import { loadGovernanceExceptions } from './store.js';
import type { GovernanceException, GovernancePolicyId } from './schema.js';

export interface GovernanceViolation {
  readonly policy: GovernancePolicyId;
  readonly subject: string;
  readonly message: string;
  readonly remedy: string;
}

export interface SuppressedGovernanceViolation extends GovernanceViolation {
  readonly exception: GovernanceException;
}

export interface GovernanceReport {
  readonly ok: boolean;
  readonly base?: string;
  readonly enabledPolicies: readonly GovernancePolicyId[];
  readonly violations: readonly GovernanceViolation[];
  readonly suppressed: readonly SuppressedGovernanceViolation[];
  readonly expiredExceptions: readonly GovernanceException[];
}

const policyIdByConfig = {
  changedFeaturesRequirePlan: 'changed-feature-plan',
  changesRequireHandoff: 'tester-handoff',
  criticalFeaturesRequireVerification: 'critical-feature-verification',
  requirementsRequireTests: 'requirement-test-coverage',
} as const;

function enabledPolicyIds(config: ResolvedConfig): readonly GovernancePolicyId[] {
  return (Object.keys(policyIdByConfig) as Array<keyof typeof policyIdByConfig>)
    .filter((key) => config.governance.policies[key])
    .map((key) => policyIdByConfig[key]);
}

function criticalityAtLeast(value: string, threshold: 'high' | 'critical'): boolean {
  const rank: Readonly<Record<string, number>> = { low: 0, medium: 1, high: 2, critical: 3 };
  return (rank[value] ?? -1) >= (rank[threshold] ?? Number.POSITIVE_INFINITY);
}

function cardEvidenceFiles(card: FeatureCard): ReadonlySet<string> {
  const claims = [card.body.summary, ...card.body.userVisibleBehaviour, ...card.body.states, ...card.body.edgeCases];
  return new Set(claims.flatMap((claim) => claim.evidence.map((ref) => ref.file)));
}

async function handoffViolation(args: { root: string; base: string; files: readonly string[] }): Promise<GovernanceViolation | undefined> {
  const file = path.join(args.root, DEFAULT_HANDOFF_FILE);
  let contents: string;
  try { contents = await fs.readFile(file, 'utf8'); }
  catch {
    return { policy: 'tester-handoff', subject: 'repository', message: `Current changes have no tester handoff at ${DEFAULT_HANDOFF_FILE}.`, remedy: `Run \`docgen handoff --base ${args.base}\` and commit the result.` };
  }
  const count = /^## Changed files \((\d+)\)$/m.exec(contents)?.[1];
  const section = contents.split(/^## Changed files \(\d+\)$/m)[1]?.split(/^## /m)[0] ?? '';
  const listed = [...section.matchAll(/^\| (?:added|modified|deleted|renamed) \| `([^`]+)` \|/gm)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined)
    .sort(compareStrings);
  const expected = [...args.files].sort(compareStrings);
  const filesMatch = listed.length === expected.length && listed.every((fileName, index) => fileName === expected[index]);
  const baseMatches = contents.includes(`- Base: \`${args.base}\``);
  if (count !== String(args.files.length) || !filesMatch || !baseMatches) {
    return { policy: 'tester-handoff', subject: 'repository', message: `Tester handoff does not match the ${args.files.length} change(s) relative to ${args.base}.`, remedy: `Regenerate it with \`docgen handoff --base ${args.base}\`.` };
  }
  return undefined;
}

/** Evaluate configured governance policies without a model or network. */
export async function evaluateGovernance(args: { readonly config: ResolvedConfig; readonly graph: EvidenceGraph; readonly base?: string; readonly now?: Date }): Promise<GovernanceReport> {
  const enabledPolicies = enabledPolicyIds(args.config);
  const now = args.now ?? new Date();
  const exceptionRecord = await loadGovernanceExceptions(args.config.root);
  const expiredExceptions = exceptionRecord.exceptions.filter((item) => Date.parse(item.expiresAt) <= now.getTime());
  const activeExceptions = exceptionRecord.exceptions.filter((item) => Date.parse(item.expiresAt) > now.getTime());
  const violations: GovernanceViolation[] = [];
  const needsChanges = args.config.governance.policies.changedFeaturesRequirePlan || args.config.governance.policies.changesRequireHandoff;

  const [features, plans, cards, answers, requirements] = await Promise.all([
    loadFeatureRecords(args.config.root),
    loadPlanRecords(args.config.root),
    loadCards(args.config.root),
    loadAnswers(args.config.root),
    loadRequirements(args.config.root),
  ]);

  let changedFeatureIds = new Set<string>();
  let changeFiles: readonly string[] = [];
  if (needsChanges) {
    if (args.base === undefined) {
      for (const policy of enabledPolicies.filter((id) => id === 'changed-feature-plan' || id === 'tester-handoff')) {
        violations.push({ policy, subject: 'repository', message: `Policy '${policy}' requires a Git comparison base.`, remedy: 'Run `docgen check --base <revision>` and configure CI to pass the pull-request base SHA.' });
      }
    } else {
      const changes = filterGitChanges(await resolveGitChanges(args.config.root, args.base), args.config.effectiveExclude);
      changeFiles = changes.changes.map((change) => change.file);
      const baseline = await readEvidenceGraphIfExists(path.join(args.config.root, DEFAULT_GRAPH_INDEX));
      const impact = analyzeChangeImpact({ current: args.graph, ...(baseline === undefined ? {} : { baseline }), changes });
      changedFeatureIds = new Set(impact.files.flatMap((fileImpact) => fileImpact.impacted)
        .filter((item) => item.node.kind === 'feature')
        .map((item) => item.node.properties?.['featureId'])
        .filter((value): value is string => typeof value === 'string'));
      if (args.config.governance.policies.changesRequireHandoff && changeFiles.length > 0) {
        const violation = await handoffViolation({ root: args.config.root, base: changes.base, files: changeFiles });
        if (violation !== undefined) violations.push(violation);
      }
    }
  }

  if (args.config.governance.policies.changedFeaturesRequirePlan) {
    for (const featureId of [...changedFeatureIds].sort(compareStrings)) {
      const governed = plans.some((plan) => plan.featureId === featureId && ['approved', 'in-progress', 'completed'].includes(plan.status));
      if (!governed) violations.push({ policy: 'changed-feature-plan', subject: featureId, message: `Changed feature '${featureId}' has no approved, in-progress, or completed plan.`, remedy: `Create and approve a plan for '${featureId}' before merging.` });
    }
  }

  if (args.config.governance.policies.criticalFeaturesRequireVerification) {
    const nodeById = new Map(args.graph.nodes.map((node) => [node.id, node]));
    const cardList = [...cards.values()];
    for (const feature of features.filter((item) => item.status === 'active' && criticalityAtLeast(item.criticality, args.config.governance.criticalityAtLeast))) {
      const memberFiles = new Set(args.graph.edges
        .filter((edge) => edge.kind === 'belongs-to-feature' && edge.to === featureNodeId(feature.id))
        .flatMap((edge) => nodeById.get(edge.from)?.provenance.evidence.map((ref) => ref.file) ?? []));
      const matchedCards = cardList.filter((card) => feature.selectors.nodes.includes(card.surfaceId) || [...cardEvidenceFiles(card)].some((file) => memberFiles.has(file)));
      const gaps: string[] = [];
      if (feature.owners.length === 0) gaps.push('has no owner');
      if (memberFiles.size === 0) gaps.push('selectors match no code evidence');
      if (matchedCards.length === 0) gaps.push('has no code-grounded behaviour card');
      const open = matchedCards.reduce((total, card) => {
        const resolved = new Set((answers.get(card.surfaceId)?.answers ?? []).map((answer) => answer.questionId));
        return total + card.body.unknowns.filter((unknown) => !resolved.has(unknown.id)).length;
      }, 0);
      if (open > 0) gaps.push(`has ${open} unanswered verification question(s)`);
      if (gaps.length > 0) violations.push({ policy: 'critical-feature-verification', subject: feature.id, message: `Critical feature '${feature.id}' ${gaps.join(', ')}.`, remedy: 'Assign an owner, correct selectors, run approved inference if needed, and record developer answers before merging.' });
    }
  }

  if (args.config.governance.policies.requirementsRequireTests) {
    const references = await scanTestReferences({ root: args.config.root, globs: args.config.trace.include, exclude: args.config.effectiveExclude });
    const matrix = buildMatrix({ requirements, cards: [...cards.values()], references, answers });
    for (const row of matrix.untested) violations.push({ policy: 'requirement-test-coverage', subject: row.requirement.id, message: `Requirement '${row.requirement.id}' has no test citation.`, remedy: `Cite ${row.requirement.id} in the covering test name or comment.` });
    for (const reference of matrix.danglingReferences) violations.push({ policy: 'requirement-test-coverage', subject: `${reference.id}@${reference.file}:${reference.line}`, message: `Test cites unknown requirement '${reference.id}' at ${reference.file}:${reference.line}.`, remedy: 'Correct the requirement id or restore the human-owned requirement record.' });
  }

  const ordered = violations.sort((a, b) => compareStrings(a.policy, b.policy) || compareStrings(a.subject, b.subject));
  const suppressed: SuppressedGovernanceViolation[] = [];
  const active: GovernanceViolation[] = [];
  for (const violation of ordered) {
    const exception = activeExceptions.find((item) => item.policy === violation.policy && (item.subject === undefined || item.subject === violation.subject));
    if (exception === undefined) active.push(violation);
    else suppressed.push({ ...violation, exception });
  }
  return { ok: active.length === 0, ...(args.base === undefined ? {} : { base: args.base }), enabledPolicies, violations: active, suppressed, expiredExceptions: [...expiredExceptions].sort((a, b) => compareStrings(a.id, b.id)) };
}

export async function evaluateGovernanceAtRoot(args: { readonly cwd: string; readonly configFile?: string; readonly graph: EvidenceGraph; readonly base?: string; readonly now?: Date }): Promise<GovernanceReport> {
  const config = await loadConfig({ root: args.cwd, ...(args.configFile === undefined ? {} : { configFile: args.configFile }) });
  return evaluateGovernance({ config, graph: args.graph, ...(args.base === undefined ? {} : { base: args.base }), ...(args.now === undefined ? {} : { now: args.now }) });
}
