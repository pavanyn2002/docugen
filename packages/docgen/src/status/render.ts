import { compareStrings } from '../util/sort.js';
import type { RepoStatus } from './collect.js';

/**
 * The fleet view.
 *
 * Deliberately not a score. A single number invites ranking teams against each
 * other, which is how a documentation effort turns into something people game
 * or resent. What is shown instead is the size of each gap, so the next action
 * is obvious per repo: describe surfaces, answer questions, triage answers, or
 * write the test that closes a requirement.
 */

export interface FleetPageArgs {
  readonly repos: readonly RepoStatus[];
  /** Repos that could not be read, and why. Never silently dropped. */
  readonly failures: readonly { readonly path: string; readonly reason: string }[];
  /** ISO timestamp. Supplied by the caller — this module reads no clock. */
  readonly generatedAt: string;
}

export function renderFleetPage(args: FleetPageArgs): string {
  const repos = [...args.repos].sort((a, b) => compareStrings(a.name, b.name));

  const totals = repos.reduce(
    (sum, repo) => ({
      surfaces: sum.surfaces + repo.surfaces,
      described: sum.described + repo.described,
      openQuestions: sum.openQuestions + repo.openQuestions,
      untriaged: sum.untriaged + repo.untriaged,
      testable: sum.testable + repo.testable,
      tested: sum.tested + repo.tested,
      drifting: sum.drifting + repo.driftingFiles,
    }),
    { surfaces: 0, described: 0, openQuestions: 0, untriaged: 0, testable: 0, tested: 0, drifting: 0 },
  );

  const lines: string[] = [
    '# Documentation across all repositories',
    '',
    `Generated ${args.generatedAt.slice(0, 10)} from ${repos.length} ` +
      `${repos.length === 1 ? 'repository' : 'repositories'}. Nothing here called a model.`,
    '',
    '## Where the fleet stands',
    '',
    `- **${totals.described} of ${totals.surfaces} surfaces** have been described at all.`,
    `- **${totals.openQuestions} questions** are waiting on a developer.`,
    `- **${totals.untriaged} answers** have not been classified as requirement, defect, or decision.`,
    `- **${totals.tested} of ${totals.testable} testable requirements** are cited by a test.`,
    totals.drifting > 0
      ? `- **${totals.drifting} generated files are out of date** and would change if \`docgen sync\` ran.`
      : '- Every repository\'s generated documentation is current.',
    '',
    '## By repository',
    '',
    '| Repository | Surfaces | Described | Open questions | Untriaged | Requirements | Tested | Drift |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const repo of repos) {
    const requirementCount = Object.values(repo.requirements).reduce((a, b) => a + b, 0);
    lines.push(
      `| ${repo.name} | ${repo.surfaces} | ${repo.described} | ${repo.openQuestions} | ` +
        `${repo.untriaged} | ${requirementCount} | ${repo.tested}/${repo.testable} | ` +
        `${repo.driftingFiles === 0 ? '—' : `**${repo.driftingFiles}**`} |`,
    );
  }

  lines.push('', '## What to do next', '');
  const actions = nextActions(repos);
  lines.push(
    actions.length === 0
      ? '_Nothing outstanding._'
      : actions.map((action) => `- ${action}`).join('\n'),
  );

  const incomplete = repos.filter((repo) => repo.unsupportedTechnologies.length > 0);
  if (incomplete.length > 0) {
    lines.push(
      '',
      '## Known-incomplete coverage',
      '',
      'docgen detected technology it cannot parse in these repositories. Their counts above are',
      'lower bounds — an empty section in one of them does not mean the repository has nothing there.',
      '',
      '| Repository | Not parsed |',
      '| --- | --- |',
      ...incomplete.map(
        (repo) => `| ${repo.name} | ${[...repo.unsupportedTechnologies].sort(compareStrings).join(', ')} |`,
      ),
    );
  }

  if (args.failures.length > 0) {
    // A repo that could not be read is reported, never quietly missing from the
    // table — an absent row reads as "nothing to do here".
    lines.push(
      '',
      '## Could not be read',
      '',
      ...[...args.failures]
        .sort((a, b) => compareStrings(a.path, b.path))
        .map((failure) => `- \`${failure.path}\` — ${failure.reason}`),
    );
  }

  lines.push('');
  return lines.join('\n');
}

/** The single most useful next step per repo, in the order work happens. */
function nextActions(repos: readonly RepoStatus[]): readonly string[] {
  const actions: string[] = [];

  for (const repo of repos) {
    if (repo.driftingFiles > 0) {
      actions.push(`\`${repo.name}\`: run \`docgen sync\` — ${repo.driftingFiles} file(s) out of date.`);
    } else if (repo.described === 0 && repo.surfaces > 0) {
      actions.push(`\`${repo.name}\`: run \`docgen bootstrap\` — ${repo.surfaces} surface(s), none described.`);
    } else if (repo.openQuestions > 0) {
      actions.push(`\`${repo.name}\`: ${repo.openQuestions} question(s) waiting — \`docgen ask --mine\`.`);
    } else if (repo.untriaged > 0) {
      actions.push(`\`${repo.name}\`: ${repo.untriaged} answer(s) to classify — \`docgen triage\`.`);
    } else if (repo.untestedRequirements > 0) {
      actions.push(
        `\`${repo.name}\`: ${repo.untestedRequirements} requirement(s) no test covers — see traceability.md.`,
      );
    }
  }

  return actions;
}
