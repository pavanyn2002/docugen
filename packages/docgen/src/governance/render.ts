import type { StoredChangeRecord } from '../changes/schema.js';
import type { FeatureCommitHistory } from '../features/history.js';
import type { StoredFeatureRecord } from '../features/schema.js';
import type { GraphNode } from '../graph/types.js';
import type { StoredPlanRecord } from '../plans/schema.js';
import type { GenerationContext } from '../types/core.js';
import { compareStrings } from '../util/sort.js';

function frontmatter(context: GenerationContext, extra: readonly string[] = []): string {
  return [
    '---',
    'generated: true',
    'trust: mixed',
    ...(context.sourceCommit === undefined ? [] : [`source_commit: ${context.sourceCommit}`]),
    ...(context.generatedAt === undefined ? [] : [`source_date: ${context.generatedAt}`]),
    ...extra,
    '---',
    '',
  ].join('\n');
}

function ref(node: GraphNode): string {
  const source = node.provenance.evidence[0];
  return source === undefined ? '' : `${source.file}${source.line === undefined ? '' : `:${source.line}`}`;
}

export function renderFeatureIndex(args: {
  readonly features: readonly StoredFeatureRecord[];
  readonly histories: ReadonlyMap<string, FeatureCommitHistory | undefined>;
  readonly context: GenerationContext;
}): string {
  const lines = [frontmatter(args.context), '# Features', '', 'Stable feature identity is human-owned. Dates and implementation scope are derived from Git and the evidence graph.', ''];
  if (args.features.length === 0) lines.push('No features are registered.', '');
  else {
    lines.push('| Feature | Status | Criticality | Owners | Introduced | Last changed |', '|---|---|---|---|---|---|');
    for (const feature of args.features) {
      const history = args.histories.get(feature.id);
      lines.push(`| [${feature.title}](features/${feature.id}.md) | ${feature.status} | ${feature.criticality} | ${feature.owners.join(', ') || 'unassigned'} | ${history?.introduced.committedAt ?? 'unknown'} | ${history?.lastChanged.committedAt ?? 'unknown'} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderFeaturePage(args: {
  readonly feature: StoredFeatureRecord;
  readonly history?: FeatureCommitHistory;
  readonly nodes: readonly GraphNode[];
  readonly plans: readonly StoredPlanRecord[];
  readonly changes: readonly StoredChangeRecord[];
  readonly context: GenerationContext;
}): string {
  const { feature } = args;
  const lines = [
    frontmatter(args.context, [`feature_id: ${feature.id}`]),
    `# ${feature.title}`,
    '',
    feature.description ?? 'No description has been recorded.',
    '',
    '## Governance',
    '',
    `- Stable ID: \`${feature.id}\``,
    `- Aliases: ${feature.aliases.map((alias) => `\`${alias}\``).join(', ') || 'none'}`,
    `- Status: ${feature.status}`,
    `- Criticality: ${feature.criticality}`,
    `- Owners: ${feature.owners.join(', ') || 'unassigned'}`,
    `- Recorded by: ${feature.recordedBy} at ${feature.recordedAt}`,
    `- Introduced: ${args.history?.introduced.committedAt ?? 'unknown'}`,
    `- Last changed: ${args.history?.lastChanged.committedAt ?? 'unknown'}`,
    '',
    `## Implementation evidence (${args.nodes.length})`,
    '',
  ];
  if (args.nodes.length === 0) lines.push('No current graph nodes match this feature’s selectors.', '');
  else {
    lines.push('| Kind | Entity | Evidence |', '|---|---|---|');
    for (const node of args.nodes) lines.push(`| ${node.kind} | ${node.label} | \`${ref(node)}\` |`);
    lines.push('');
  }
  lines.push(`## Plans (${args.plans.length})`, '');
  for (const plan of args.plans) lines.push(`- [${plan.title}](../plans/${plan.id}.md) — ${plan.status}`);
  if (args.plans.length === 0) lines.push('No plan is linked.');
  lines.push('', `## Change history (${args.changes.length})`, '');
  for (const change of [...args.changes].sort((a, b) => compareStrings(b.headDate ?? b.recordedAt, a.headDate ?? a.recordedAt))) {
    lines.push(`- **${change.headDate ?? change.recordedAt} — ${change.summary}** (\`${change.id}\`, ${change.kind}, ${change.files.length} files)`);
  }
  if (args.changes.length === 0) lines.push('No governed change has been recorded.');
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderPlanPage(plan: StoredPlanRecord, context: GenerationContext): string {
  const lines = [
    frontmatter(context, [`plan_id: ${plan.id}`, `feature_id: ${plan.featureId}`]),
    `# ${plan.title}`,
    '',
    plan.summary,
    '',
    '## Lifecycle',
    '',
    `- Status: ${plan.status}`,
    `- Feature: [${plan.featureId}](../features/${plan.featureId}.md)`,
    `- Recorded by: ${plan.recordedBy} at ${plan.recordedAt}`,
    '',
    '## Acceptance criteria',
    '',
  ];
  for (const criterion of plan.acceptanceCriteria) lines.push(`- **${criterion.id}:** ${criterion.text}`);
  if (plan.acceptanceCriteria.length === 0) lines.push('None recorded.');
  lines.push('', '## Risks', '');
  for (const risk of plan.risks) lines.push(`- ${risk}`);
  if (plan.risks.length === 0) lines.push('None recorded.');
  lines.push('', '## Tester notes', '');
  for (const note of plan.testNotes) lines.push(`- ${note}`);
  if (plan.testNotes.length === 0) lines.push('None recorded.');
  lines.push('', '## Status history', '');
  for (const transition of plan.transitions) {
    lines.push(`- ${transition.changedAt}: ${transition.from} -> ${transition.to} by ${transition.changedBy}${transition.note === undefined ? '' : ` — ${transition.note}`}`);
  }
  if (plan.transitions.length === 0) lines.push('No transition has been recorded.');
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderChangelog(changes: readonly StoredChangeRecord[], context: GenerationContext): string {
  const sorted = [...changes].sort(
    (a, b) => compareStrings(b.headDate ?? b.recordedAt, a.headDate ?? a.recordedAt) || compareStrings(a.id, b.id),
  );
  const lines = [frontmatter(context), '# Governed changelog', '', 'Entries are immutable, attributed change records. Commit dates come from Git; recording dates identify the human assertion.', ''];
  if (sorted.length === 0) lines.push('No governed changes have been recorded.', '');
  for (const change of sorted) {
    lines.push(`## ${change.headDate ?? change.recordedAt} — ${change.summary}`, '', `- ID: \`${change.id}\``, `- Kind: ${change.kind}`, `- Features: ${change.featureIds.map((id) => `\`${id}\``).join(', ')}`, `- Plans: ${change.planIds.map((id) => `\`${id}\``).join(', ') || 'none'}`, `- Base: \`${change.base}\``, `- Head: ${change.headCommit === undefined ? 'uncommitted/unknown' : `\`${change.headCommit}\``}`, `- Recorded by: ${change.recordedBy} at ${change.recordedAt}`, '', 'Changed files:', '');
    for (const file of change.files) lines.push(`- ${file.status}: \`${file.file}\`${file.previousFile === undefined ? '' : ` (from \`${file.previousFile}\`)`}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
