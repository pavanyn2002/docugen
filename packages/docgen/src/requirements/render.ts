import type { GenerationContext } from '../types/core.js';
import { note, renderFrontMatter, section, warning } from '../render/markdown.js';
import { compareStrings } from '../util/sort.js';
import { KIND_LABELS, REQUIREMENT_KINDS } from './types.js';
import type { Requirement, RequirementKind, SurfaceRequirements } from './types.js';

/**
 * The requirements page.
 *
 * This is the first page in docgen that is `verified` end to end: every line
 * traces to an answer a named developer gave and then classified. It is
 * therefore the only page QA can treat as a specification, and it says so —
 * the whole point of separating it from the behaviour pages is that a reader
 * never has to work out which parts were checked.
 */

export interface RequirementsPageArgs {
  readonly requirements: ReadonlyMap<string, SurfaceRequirements>;
  readonly context: GenerationContext;
  /** Answered questions not yet triaged, so the page states its own coverage. */
  readonly pendingCount: number;
}

export function renderRequirementsPage(args: RequirementsPageArgs): string {
  const all = [...args.requirements.values()]
    .flatMap((surface) => surface.requirements)
    .sort((a, b) => compareStrings(a.id, b.id));

  const head = renderFrontMatter({
    title: 'Requirements',
    // Every entry here was stated by a developer and classified by one. That is
    // the definition of verified in this tool.
    confidence: 'verified',
    context: args.context,
    regenerateWith: 'docgen triage',
  });

  let body = `${head}# Requirements\n\n`;
  body +=
    'Each entry below was answered by a named developer and then classified by one. Nothing ' +
    'here was written by a model. This is the only generated page that can be read as a ' +
    'specification.\n\n';

  if (all.length === 0) {
    body += note([
      'Nothing has been triaged yet. Answer questions with `docgen answer`, then run',
      '`docgen triage` to classify what those answers mean.',
    ]);
    return body;
  }

  if (args.pendingCount > 0) {
    // Stated rather than implied: a reader must not mistake this page for the
    // complete set of what is known.
    const one = args.pendingCount === 1;
    body += warning([
      `This is incomplete. ${args.pendingCount} answered question${one ? '' : 's'} ${
        one ? 'has' : 'have'
      } not been triaged yet,`,
      `so whatever ${one ? 'it establishes' : 'they establish'} is absent below. Run \`docgen triage\` to work through ${
        one ? 'it' : 'them'
      }.`,
    ]);
  }

  body += section('Summary', renderSummary(all));

  for (const kind of REQUIREMENT_KINDS) {
    const forKind = all.filter((requirement) => requirement.kind === kind);
    if (forKind.length === 0) continue;
    body += section(`${KIND_LABELS[kind]} (${forKind.length})`, renderGroup(forKind));
  }

  return body;
}

function renderSummary(all: readonly Requirement[]): string {
  const counts = REQUIREMENT_KINDS.map((kind) => ({
    kind,
    count: all.filter((requirement) => requirement.kind === kind).length,
  })).filter((row) => row.count > 0);

  return [
    '| Kind | Count |',
    '| --- | --- |',
    ...counts.map((row) => `| ${KIND_LABELS[row.kind]} | ${row.count} |`),
    '',
  ].join('\n');
}

function renderGroup(requirements: readonly Requirement[]): string {
  return requirements
    .map((requirement) => {
      const status =
        requirement.status === 'confirmed' ? '' : ` — **${requirement.status}**`;
      const attribution = `<sub>${requirement.surfaceId} · ${requirement.recordedBy}${
        requirement.recordedAt.length > 0 ? `, ${requirement.recordedAt.slice(0, 10)}` : ''
      }</sub>`;
      const detail = requirement.note === undefined ? '' : `\n${requirement.note}\n`;

      return (
        `### ${requirement.id}${status}\n\n` +
        `${requirement.title}\n\n` +
        `**${requirement.statement}**\n${detail}\n` +
        `${attribution}\n`
      );
    })
    .join('\n');
}

/** Counts by kind, for the command's own report. */
export function countByKind(
  requirements: ReadonlyMap<string, SurfaceRequirements>,
): Readonly<Record<RequirementKind, number>> {
  const counts: Record<RequirementKind, number> = {
    requirement: 0,
    bug: 0,
    decision: 0,
    context: 0,
  };

  for (const surface of requirements.values()) {
    for (const requirement of surface.requirements) counts[requirement.kind] += 1;
  }

  return counts;
}
