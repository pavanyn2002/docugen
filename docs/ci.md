# CI and automation

The gate that stops documentation rotting is `docgen check`. It never calls a model, so it costs nothing per pull request and cannot be flaky.

Agents run `docgen session end` before handoff, but CI remains the universal
enforcement boundary: an interrupted editor or disabled local hook cannot
bypass the pull-request check.

## The quickest way

```bash
docgen init
```

Where the repo already uses GitHub Actions, this writes `.github/workflows/docgen.yml` targeting the branch the repo actually has, pinned to the docgen version that installed it.

## What it generates

When docgen is a dependency of the repo:

```yaml
name: Documentation

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    env:
      DOCGEN_BASE: ${{ github.event.pull_request.base.sha || (github.event.before != '0000000000000000000000000000000000000000' && github.event.before) || '4b825dc642cb6eb9a060e54bf8d69288fbee4904' }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - run: npm ci

      - name: Check documentation is current
        run: npx docgen check --base "$DOCGEN_BASE"
```

When it is not a dependency — a Python or Go repo, say — the workflow fetches a pinned version instead, and skips `npm ci` entirely:

```yaml
      - name: Check documentation is current
        run: npx --yes @tatvaops/docgen@0.1.0 check
```

## Why the version is pinned

An engine upgrade can legitimately change the generated output. Pinning makes that a reviewed commit rather than a build that fails one morning for no reason anyone changed.

The cost of pinning is a fleet drifting onto a dozen different versions, so `docgen init` also adds a weekly Dependabot rule where docgen is a local dependency:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    allow:
      - dependency-name: "@tatvaops/docgen"
```

It never touches a repo that already has an update policy of its own.

## What `check` catches

| Kind | Means | Fix |
|---|---|---|
| `changed` | A generated file would be rewritten | `docgen sync` |
| `missing` | A generated file should exist and does not | `docgen sync` |
| `orphaned` | A page documents something that no longer exists | `docgen sync` deletes it |

`orphaned` is the one that matters most. A page describing a deleted feature is worse than a stale one, because nothing about it looks wrong.

The fix is always the same:

```bash
docgen sync && git add docs/ && git commit -m "docs: sync"
```

## Strict mode

```bash
docgen check --strict
```

Additionally fails on unanswered questions and untriaged answers.

This is right for a pilot repository whose queue is drained. It is the wrong fleet-wide default: it fails every repository on day one, and a gate that fails everywhere gets disabled in week one. Start with plain `check` and tighten per repo once the queue is under control.

## Other CI systems

The gate is one command with no dependencies beyond Node, so it drops into anything.

For an earlier local signal, `docgen init --hooks` installs an opt-in pre-push
hook that runs the same non-mutating check. It refuses to replace a team-owned
hook or a different configured hooks path.

**GitLab CI**

```yaml
documentation:
  image: node:22
  script:
    - npx --yes @tatvaops/docgen@0.1.0 check
```

**A git pre-push hook**

```bash
#!/bin/sh
npx docgen check || {
  echo "Documentation is out of date. Run 'docgen sync' and commit."
  exit 1
}
```

## Should CI run `bootstrap`?

Usually not. It costs money on every run and needs an authenticated backend, which a runner does not have unless you configure `infer.agent: "api"` with an API key.

The cheaper pattern is: developers run `bootstrap` when behaviour changes, commit the cards, and CI only ever runs `check`. Cards are cached per surface, so even a deliberate periodic `bootstrap` only pays for surfaces whose code actually changed.

If you do want it in CI — a weekly scheduled job is a reasonable place — install `@anthropic-ai/sdk`, set `ANTHROPIC_API_KEY`, and set `infer.agent: "api"`.

## Tracking the whole fleet

```bash
docgen fleet ../*/ --out fleet.md
```

Free, no model. Suitable for a nightly job that publishes one page across every
repository. The dashboard reports documentation coverage and drift alongside
evidence-graph nodes, edges, extraction gaps, features, critical features,
plans, and attributed changes. See [Rolling out across repos](rollout.md).

## Supply-chain checks and SBOMs

Docgen can enforce deterministic dependency hygiene without network access:

```bash
docgen security scan --strict
docgen security sbom --out artifacts/sbom.cdx.json
```

The strict scan fails for findings and dependency formats Docgen cannot inspect,
so enable it after reviewing the first report. The generated CycloneDX 1.6 SBOM
is stable for an unchanged lockfile and can be uploaded as a CI artifact.

This does not replace Dependabot, `npm audit`, OSV-Scanner, or another current
advisory source. The JSON report always states that CVE coverage was not
evaluated, making that boundary machine-readable.

## Machine-readable output

Every reporting command takes `--json` on stdout, with diagnostics on stderr:

```bash
docgen check --json | jq '.drift'
docgen status --json | jq '{surfaces, described, openQuestions, graph}'
docgen trace --json | jq '.untested'
docgen ask --json | jq '.questions[] | {id, question, likelyOwner}'
```

`docgen ask --json` is the useful one for automation — it carries the likely owner per question, which is enough to open tickets or post a digest.
