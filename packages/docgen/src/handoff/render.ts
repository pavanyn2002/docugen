import type { FeatureCommitHistory } from '../features/history.js';
import type { StoredFeatureRecord } from '../features/schema.js';
import type { GitFileChange, CommitInfo } from '../util/git.js';
import type { GraphNode } from '../graph/types.js';
import type { StoredPlanRecord } from '../plans/schema.js';
import type { Requirement } from '../requirements/types.js';
import type { TestReference } from '../trace/scan.js';

export interface TesterHandoffFeature {
  readonly record: StoredFeatureRecord;
  readonly history?: FeatureCommitHistory;
}

export interface TesterHandoffData {
  readonly base: string;
  readonly head?: CommitInfo;
  readonly baselineUsed: boolean;
  readonly changes: readonly GitFileChange[];
  readonly features: readonly TesterHandoffFeature[];
  readonly plans: readonly StoredPlanRecord[];
  readonly impactedEntities: readonly GraphNode[];
  readonly affectedRequirements: readonly Requirement[];
  readonly affectedTests: readonly TestReference[];
  readonly generatedPages: readonly string[];
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function source(node: GraphNode): string {
  const ref = node.provenance.evidence[0];
  return ref === undefined ? '' : `${ref.file}${ref.line === undefined ? '' : `:${ref.line}`}`;
}

/** Deterministic tester-facing projection of Git, graph, feature, and plan evidence. */
export function renderTesterHandoff(data: TesterHandoffData): string {
  const lines: string[] = [
    '---',
    'generated: true',
    'trust: mixed',
    `base: ${JSON.stringify(data.base)}`,
    ...(data.head === undefined
      ? []
      : [`source_commit: ${data.head.sha}`, `source_date: ${data.head.committedAt}`]),
    '---',
    '',
    '# Tester handoff',
    '',
    '> Code impact below is statically extracted. Acceptance criteria, risks, and test notes are',
    '> human-owned plan records. Missing evidence is called out instead of being guessed.',
    '',
    '## Git scope',
    '',
    `- Base: \`${data.base}\``,
    `- Head: ${data.head === undefined ? 'unavailable' : `\`${data.head.sha}\` (${data.head.committedAt})`}`,
    `- Previous graph used for removed code: ${data.baselineUsed ? 'yes' : 'no'}`,
    '',
    `## Changed files (${data.changes.length})`,
    '',
  ];
  if (data.changes.length === 0) {
    lines.push('No Git changes were detected.', '');
  } else {
    lines.push('| Status | File | Previous path |', '|---|---|---|');
    for (const change of data.changes) {
      lines.push(`| ${change.status} | \`${cell(change.file)}\` | ${change.previousFile === undefined ? '' : `\`${cell(change.previousFile)}\``} |`);
    }
    lines.push('');
  }

  lines.push(`## Affected features (${data.features.length})`, '');
  if (data.features.length === 0) {
    lines.push('No registered feature selector matched the affected graph. Product scope requires review.', '');
  } else {
    lines.push('| Feature | Status | Criticality | Owners | Introduced | Last changed |', '|---|---|---|---|---|---|');
    for (const feature of data.features) {
      lines.push(
        `| ${cell(feature.record.title)} (\`${feature.record.id}\`) | ${feature.record.status} | ${feature.record.criticality} | ${cell(feature.record.owners.join(', ') || 'unassigned')} | ${feature.history?.introduced.committedAt ?? 'unknown'} | ${feature.history?.lastChanged.committedAt ?? 'unknown'} |`,
      );
    }
    lines.push('');
  }

  lines.push(`## Statically affected surfaces (${data.impactedEntities.length})`, '');
  if (data.impactedEntities.length === 0) {
    lines.push('No endpoint, route, job, schema, configuration, or surface node was reached.', '');
  } else {
    lines.push('| Kind | Entity | Evidence |', '|---|---|---|');
    for (const node of data.impactedEntities) {
      lines.push(`| ${node.kind} | ${cell(node.label)} | \`${cell(source(node))}\` |`);
    }
    lines.push('');
  }

  lines.push(`## Affected requirements (${data.affectedRequirements.length})`, '');
  if (data.affectedRequirements.length === 0) {
    lines.push('No human-owned requirement is linked to an affected surface.', '');
  } else {
    lines.push('| Requirement | Kind | Status | Surface | Statement |', '|---|---|---|---|---|');
    for (const requirement of data.affectedRequirements) {
      lines.push(`| \`${requirement.id}\` | ${requirement.kind} | ${requirement.status} | \`${requirement.surfaceId}\` | ${cell(requirement.statement)} |`);
    }
    lines.push('');
  }

  lines.push(`## Existing test evidence (${data.affectedTests.length})`, '');
  if (data.affectedTests.length === 0) {
    lines.push('No test explicitly cites an affected requirement ID. Test coverage requires review.', '');
  } else {
    lines.push('| Requirement | Test evidence |', '|---|---|');
    for (const reference of data.affectedTests) {
      lines.push(`| \`${reference.id}\` | \`${cell(reference.file)}:${reference.line}\` |`);
    }
    lines.push('');
  }

  lines.push(`## Documentation surfaces to review (${data.generatedPages.length})`, '');
  if (data.generatedPages.length === 0) lines.push('No generated page mapping was found.', '');
  else for (const page of data.generatedPages) lines.push(`- \`${page}\``);
  lines.push('');

  lines.push(`## Approved testing intent (${data.plans.length} plan${data.plans.length === 1 ? '' : 's'})`, '');
  if (data.plans.length === 0) {
    lines.push('No non-cancelled plan is linked to the affected features. Acceptance criteria are unknown.', '');
  }
  for (const plan of data.plans) {
    const transition = plan.transitions.at(-1);
    lines.push(
      `### ${plan.title}`,
      '',
      `- Plan: \`${plan.id}\``,
      `- Feature: \`${plan.featureId}\``,
      `- Status: ${plan.status}`,
      `- Recorded by: ${plan.recordedBy} at ${plan.recordedAt}`,
      ...(transition === undefined
        ? []
        : [`- Latest transition: ${transition.from} -> ${transition.to}, ${transition.changedBy} at ${transition.changedAt}`]),
      '',
      plan.summary,
      '',
      'Acceptance criteria:',
      '',
    );
    if (plan.acceptanceCriteria.length === 0) lines.push('- None recorded.');
    for (const criterion of plan.acceptanceCriteria) lines.push(`- **${criterion.id}:** ${criterion.text}`);
    lines.push('', 'Known risks:', '');
    if (plan.risks.length === 0) lines.push('- None recorded.');
    for (const risk of plan.risks) lines.push(`- ${risk}`);
    lines.push('', 'Tester notes:', '');
    if (plan.testNotes.length === 0) lines.push('- None recorded.');
    for (const note of plan.testNotes) lines.push(`- ${note}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
