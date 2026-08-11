/**
 * The CI gate, as a workflow a team can drop in.
 *
 * Written as a file rather than documented in prose because a gate that has to
 * be hand-assembled from a README will be assembled differently in every repo,
 * and then it will be wrong in some of them. This one runs `docgen check`,
 * which never calls a model — a gate that cost money per pull request would be
 * switched off within a month.
 */

export interface CiWorkflowArgs {
  /** Default branch, so the workflow triggers on the right target. */
  readonly defaultBranch: string;
  /**
   * Whether docgen is a dependency of this repo. A locally installed docgen is
   * run through the repo's own install; otherwise the runner has nothing on
   * PATH and the package has to be fetched and pinned explicitly.
   */
  readonly local: boolean;
  /** Version to pin when fetching. Ignored when `local`. */
  readonly version: string;
}

export function renderGithubWorkflow(args: CiWorkflowArgs): string {
  // Without this split the generated workflow runs `npm ci` in repos that have
  // no manifest, and calls a `docgen` that was never installed. Both fail in a
  // way that looks like docgen is broken rather than misconfigured.
  const steps = args.local
    ? [
        '      - uses: actions/setup-node@v4',
        "        with:",
        "          node-version: '22'",
        '',
        '      - run: npm ci',
        '',
        '      - name: Check documentation is current',
        '        run: npx docgen check --base "$DOCGEN_BASE"',
      ]
    : [
        '      - uses: actions/setup-node@v4',
        "        with:",
        "          node-version: '22'",
        '',
        '      # docgen is not a dependency of this repo, so it is fetched here.',
        '      # The version is pinned: an engine upgrade can legitimately change',
        '      # the output, and that should be a deliberate commit rather than a',
        '      # build that fails one morning for no reason anyone changed.',
        '      - name: Check documentation is current',
        `        run: npx --yes @tatvaops/docgen@${args.version} check --base "$DOCGEN_BASE"`,
      ];

  return `name: Documentation

# Fails when the committed documentation no longer matches the code.
# Never calls a model: it re-renders from the committed cards and answers and
# compares bytes, so it costs nothing and cannot be flaky.

on:
  pull_request:
    branches: [${args.defaultBranch}]
  push:
    branches: [${args.defaultBranch}]

jobs:
  check:
    runs-on: ubuntu-latest
    env:
      DOCGEN_BASE: \${{ github.event.pull_request.base.sha || (github.event.before != '0000000000000000000000000000000000000000' && github.event.before) || '4b825dc642cb6eb9a060e54bf8d69288fbee4904' }}
    steps:
      - uses: actions/checkout@v4
        with:
          # docgen dates pages from the source commit, so it needs the commit
          # itself and the exact comparison base used by governance policies.
          fetch-depth: 0

${steps.join('\n')}
`;
}

export const GITHUB_WORKFLOW_PATH = '.github/workflows/docgen.yml';

export const DEPENDABOT_PATH = '.github/dependabot.yml';

/**
 * Keep the pinned engine moving.
 *
 * The CI gate pins a docgen version deliberately, which is correct — an engine
 * upgrade can legitimately change the output, and that should be a reviewed
 * commit. The cost of pinning is that a fleet quietly ends up on a dozen
 * different versions. A weekly update PR is what stops that without making an
 * upgrade something anyone has to remember.
 *
 * Only written when a repo has no dependabot config: overwriting a team's own
 * update policy to add one ecosystem would be a hostile thing for an install
 * command to do.
 */
export function renderDependabotConfig(): string {
  return `version: 2

updates:
  # Keeps @tatvaops/docgen moving so the fleet does not drift onto a dozen
  # different engine versions. Review the diff: an engine upgrade can change
  # the generated output, which is exactly why the version is pinned.
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    allow:
      - dependency-name: "@tatvaops/docgen"
    commit-message:
      prefix: chore
`;
}
