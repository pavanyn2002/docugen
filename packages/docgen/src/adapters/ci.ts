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
        '        run: npx docgen check',
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
        `        run: npx --yes @tatvaops/docgen@${args.version} check`,
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
    steps:
      - uses: actions/checkout@v4
        with:
          # docgen dates pages from the source commit, so it needs the commit
          # itself. A shallow clone of depth 1 is enough for that.
          fetch-depth: 1

${steps.join('\n')}
`;
}

export const GITHUB_WORKFLOW_PATH = '.github/workflows/docgen.yml';
