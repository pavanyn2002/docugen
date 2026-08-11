# Command reference

Every command, every flag.

**Cost:** only `bootstrap` calls a model. Everything else is free, makes no network call, and is safe to run in a loop or across a whole fleet.

## Global options

Available on every command.

| Flag | Effect |
|---|---|
| `--cwd <path>` | Target repo root. Default: current directory. A path that does not exist is an error, not an empty repo. |
| `-c, --config <path>` | Explicit config file. Default: auto-discover `docgen.config.{ts,js,mjs,json}`. |
| `--verbose` | Diagnostic output, including per-extractor detail. |
| `--quiet` | Errors only. |
| `--color` / `--no-color` | Force or disable ANSI colour. Respects `NO_COLOR` and `FORCE_COLOR`. |
| `-v, --version` | Engine version. |

Diagnostics go to stderr; `--json` payloads go to stdout. You can pipe one without the other.

---

## `docgen index`

Build the local, schema-validated AST evidence graph. No model, network, or cost.

```bash
docgen index
docgen index --dry-run --json
docgen index --no-symbols
```

By default the canonical graph is written atomically to
`.docgen/cache/evidence-graph.json`. A cache-local `.gitignore` prevents the
rebuildable index from being committed. The same run writes
`.docgen/cache/file-fingerprints.json` and reports added, changed, and deleted
source counts. It also maintains `.docgen/cache/graph-partitions.json`, replaces
the reverse dependency closure of changed files, and reuses unaffected
partitions. Extractor results and emitted symbols are scoped to that closure;
the symbol analyzers may still read other modules as resolution context, but do
not rebuild their partitions. Reused partitions must remain byte-identical and
the merged graph must pass normal graph validation. A failed integrity check
automatically performs a clean extraction and is reported as `fallback` in text
and JSON output. Clean-build equivalence is enforced by regression tests rather
than paying for a second extraction on every edit. JSON output reports the
number of files in `extractionScope` and identifies `partition-integrity`,
`clean-equivalent`, or `cache-integrity` verification. When all
fingerprints are unchanged, the resolved config, engine version, and symbol
mode match, and the canonical graph agrees with its partitions, indexing reports `cached` and
skips every extractor and AST parse. JSON output exposes `cacheHit` and
`extractionSkipped` explicitly. It also lists the stable ID, version, backend,
languages, and extensions in `symbolAdapters`; adapter metadata is part of the
cache identity. Built-in symbol coverage currently includes TypeScript,
JavaScript, and Python.

| Flag | Effect |
|---|---|
| `-o, --out <path>` | Use another path inside the target repository. |
| `--no-symbols` | Keep framework facts but omit function, class, method, and call relationships. |
| `--dry-run` | Build and validate without writing. |
| `--json` | Machine-readable summary on stdout. |

---

## Graph queries

Queries rebuild the graph from the current working tree before answering, so
they cannot silently serve a stale cache.

```bash
docgen query payment
docgen query checkout --kinds route,endpoint,symbol
docgen explain "endpoint:endpoints:endpoint:POST:/orders"
docgen path "route:/checkout" "schema:payments" --direction both
```

`query` searches node ids and labels. `explain` shows direct relationships and
source evidence. `path` returns a deterministic shortest path and can be
restricted with `--edge-kinds` or `--max-depth`. All three support `--json`.
Statically proven Prisma, Django, and SQLAlchemy operations appear as
`references` edges from the calling symbol to the extracted schema node, with
`referenceKind: database-access`, ORM, operation, and model properties.
Bull, BullMQ, and amqplib publishers similarly appear as `references` edges to
the extracted consumer job with `referenceKind: queue-producer`, runtime,
literal channel, operation, and job name when one is declared.

---

## `docgen impact`

Compare the current working tree with a Git revision and trace changed files to
their downstream callers, endpoints, routes, jobs, schemas, and other graph
entities. This is local static analysis and does not call a model or network.

```bash
docgen impact
docgen impact --base origin/main
docgen impact --base HEAD --max-depth 8 --json
```

Added, modified, deleted, and Git-detected renamed files are included. When a
previous `.docgen/cache/evidence-graph.json` exists, it is also queried so
deleted symbols and removed relationships remain visible. File introduction
and last-change dates come from commits; uncommitted new files have no invented
timestamp.

| Flag | Effect |
|---|---|
| `--base <ref>` | Compare against this local Git commit, tag, or branch. Default: `HEAD`. |
| `--max-depth <n>` | Maximum incoming graph relationships to traverse. Default: `6`. |
| `--limit <n>` | Maximum impacted entities displayed per changed file. Default: `50`. |
| `--json` | Machine-readable report on stdout. |

---

## `docgen feature`

Register stable, human-owned feature identities and map code evidence to them.
Feature records live in `docs/.features/<id>.json`; automatic generation never
rewrites them.

```bash
docgen feature add checkout \
  --title "Checkout" \
  --files "src/checkout/**,src/payments/**" \
  --owners "payments@example.com" \
  --criticality high

docgen feature list
docgen feature show checkout --json
```

`feature add` accepts `--aliases` for previous stable names, `--nodes` for exact
graph node IDs, `--description`, `--status`, and `--criticality`. The record is
attributed to the current Git email and the explicit recording time. Feature
introduction and last-change dates shown by `feature show` are different: they
come only from commits touching selected evidence files.

File and node selectors create `belongs-to-feature` graph relationships during
every extraction. Consequently, `docgen impact` can report affected features
without a model inferring product scope from filenames.

---

## `docgen plan`

Create a human-owned implementation plan for a registered feature. Repeating
`--acceptance`, `--risk`, or `--test-note` preserves each item separately;
acceptance criteria receive stable IDs such as `AC-01`.

```bash
docgen plan create checkout-retry \
  --feature checkout \
  --title "Checkout retry handling" \
  --summary "Make failed retries visible and idempotent" \
  --acceptance "A failed payment can be retried without a duplicate order" \
  --risk "Duplicate payment submission" \
  --test-note "Verify the original idempotency key is reused"

docgen plan list
docgen plan show checkout-retry
docgen plan status checkout-retry approved --note "Product approval"
docgen plan status checkout-retry in-progress
docgen plan status checkout-retry completed
```

Plans live in `docs/.plans/<id>.json`. Status changes follow a validated
`draft -> approved -> in-progress -> completed` lifecycle, with cancellation
paths, and append the actor, time, and optional note to an audit history.

---

## `docgen handoff`

Generate a tester-ready Markdown handoff from the current Git diff, evidence
graph, registered features, and approved, in-progress, or completed plans. Draft
and cancelled intent is never presented to testers as approved acceptance.

```bash
docgen handoff --base origin/main
docgen handoff --base HEAD --dry-run
docgen handoff --out docs/handoffs/release-42.md --json
```

The default output is `docs/handoffs/tester-handoff.md`. It lists changed
files, affected product features, statically reached routes/endpoints/jobs/data
and configuration, Git-derived feature dates, acceptance criteria, risks, and
tester notes. Extracted and human-owned sections are labeled separately. It
does not use a model or invent missing acceptance criteria.

---

## `docgen change`

Snapshot the current Git comparison as an immutable, attributed change record.
The command validates every linked feature and plan and records the exact
added, modified, deleted, and renamed files.

```bash
docgen change record checkout-retry-enabled \
  --summary "Enable safe checkout retries" \
  --features checkout \
  --plans checkout-retry \
  --kind fix \
  --base origin/main
```

Records live in `docs/.changes/<id>.json`. `--kind` accepts `feature`, `fix`,
`refactor`, `breaking`, or `docs`. The stored head SHA and date come from Git;
the recorder and recording time identify the human assertion. Records are
immutable and are projected into `change` nodes and `affected-by-change` graph
relationships.

After recording a change, run `docgen sync`. It deterministically updates:

- `docs/generated/features.md` and one page per feature;
- one generated page per plan, including acceptance and lifecycle history;
- `docs/generated/changelog.md` from immutable change records.

`docgen check` enforces these pages in CI without a model or network.

---

## `docgen extract`

Static analysis. Writes `docs/generated/`. No model, no network, no cost.

```bash
docgen extract
docgen extract --only routes,schema
docgen extract --dry-run --json
```

| Flag | Effect |
|---|---|
| `-o, --out <path>` | Override the output directory. |
| `--only <ids>` | Restrict to some extractors: `routes`, `schema`, `endpoints`, `jobs`, `config`, `deps`. |
| `--dry-run` | Report what would be generated, writing nothing. |
| `--json` | Machine-readable summary on stdout. |

Output is byte-identical across runs, so regenerating produces no diff unless the code changed.

---

## `docgen report`

Coverage summary plus cross-extractor findings — things only visible by comparing extractors against each other, such as an endpoint defined in a spec with no handler behind it, or an env var declared but never read.

```bash
docgen report
docgen report --full
```

| Flag | Effect |
|---|---|
| `--full` | List every finding item rather than a preview. |
| `--json` | Machine-readable output on stdout. |

Always exits 0. Findings are observations for a human to judge, not failures. The gate that fails a build is `docgen check`.

---

## `docgen bootstrap`

**The only command that costs money.** Infers a feature card per surface using a coding CLI you have already signed in to.

```bash
docgen bootstrap --dry-run     # what would run, and which backends exist
docgen bootstrap --limit 5     # bounded first run
docgen bootstrap               # all surfaces
docgen bootstrap --force       # ignore the cache
```

| Flag | Effect |
|---|---|
| `--dry-run` | Report surfaces and available backends. No model call, nothing written. |
| `--limit <n>` | Only process the first N surfaces. |
| `--force` | Regenerate every surface, even ones whose inputs are unchanged. |

**Caching.** A surface is re-inferred only when its code or its recorded answers changed, or when the prompt version changed. Everything else is reused for free. This is what makes it affordable to run repeatedly.

Note that the cache key does **not** include the backend, so switching from Codex to Claude will not regenerate on its own. Use `--force` if you want that.

**Backends**, tried in order under `infer.agent: "auto"`:

| Backend | Command | Setup |
|---|---|---|
| `claude` | `claude -p` | Install Claude Code and run `claude` once to sign in. |
| `codex` | `codex exec` | Install the Codex CLI and run `codex login`. |
| `cursor` | `cursor-agent -p` | Install cursor-agent and sign in to Cursor. |
| `api` | Anthropic API | `npm i @anthropic-ai/sdk` and set `ANTHROPIC_API_KEY`. For CI, where no interactive CLI is signed in. |

An explicitly configured backend that is unavailable is an error, never a silent downgrade — switching models changes both what the documentation says and what it costs.

Also refreshes the static pages, so the run leaves the repo passing `docgen check`.

---

## `docgen ask`

The open question queue. Read-only.

```bash
docgen ask
docgen ask --mine
docgen ask --surface checkout --limit 5
docgen ask --json
```

| Flag | Effect |
|---|---|
| `--mine` | Only questions on code you last touched, by git identity. |
| `--surface <slug>` | Only questions for one surface. Matches on slug or title substring. |
| `--limit <n>` | Show at most N. |
| `--json` | Machine-readable output on stdout. |

`--mine` is a filter, not an assignment. Anyone can answer anything; the filter exists because a queue of 200 unordered questions gets ignored.

---

## `docgen answer`

Record an answer as ground truth. **This is the only way a claim becomes `verified`.**

```bash
docgen answer <surface> <question-id> <answer>
docgen answer screen auth-requirement 1
docgen answer checkout retry-policy "The user must resubmit."
docgen answer checkout currency "GBP only" --note "EUR is planned for Q3."
```

| Argument | |
|---|---|
| `surface` | Surface slug, as shown by `docgen ask`. |
| `question-id` | Question id, as shown by `docgen ask`. |
| `answer` | Free text, or the number of one of the offered options. |

| Flag | Effect |
|---|---|
| `--note <text>` | Extra context recorded alongside the answer. |

Written to `docs/.answers/<surface>.yaml` under your git identity. Re-answering replaces the previous answer rather than appending — two conflicting answers to one question would leave a reader unable to tell which is current.

Re-renders on the spot, so the answer shows as `verified` immediately without waiting for the next paid run. No model call.

---

## `docgen triage`

Decide what each answer *means*. An answer says what happens; it does not say whether that is intended.

```bash
docgen triage                                 # interactive walk
docgen triage --list                          # what is waiting
docgen triage --list --json
docgen triage screen auth-requirement requirement
docgen triage checkout tax bug --note "Filed as PROJ-412."
```

| Argument | |
|---|---|
| `surface` | Omit for an interactive walk. |
| `question-id` | As shown by `docgen triage --list`. |
| `kind` | `requirement`, `bug`, `decision`, or `context`. |

| Flag | Effect |
|---|---|
| `--list` | Show what is waiting, changing nothing. |
| `--json` | Machine-readable output on stdout. |
| `--note <text>` | Extra context recorded with the classification. |

| Kind | Means | Gets a test case |
|---|---|---|
| `requirement` | Intended behaviour | Yes |
| `bug` | A defect — the code does this, and it should not | Yes, as a regression test |
| `decision` | A deliberate technical choice worth recording | No |
| `context` | Useful to know, but not a requirement | No |

Interactive mode needs a terminal. In a pipe it fails with instructions rather than reading EOF and recording a classification nobody made.

**Ids** are scoped to their surface — `REQ-checkout-01`, `BUG-orders-02` — so two developers triaging different surfaces never collide and no shared counter needs coordinating. Ids are never reused, including numbers freed by a deletion, because a test or a ticket may already quote one. Reclassifying issues a fresh id so the prefix cannot contradict the kind.

---

## `docgen trace`

Link requirements to the tests that check them.

```bash
docgen trace
docgen trace --strict
docgen trace --json
```

| Flag | Effect |
|---|---|
| `--strict` | Exit non-zero when any of the three gaps is non-empty. |
| `--json` | Machine-readable output on stdout. |

A developer links a test by putting the requirement id in the test name or a comment. Nothing else has to be maintained:

```ts
it('REQ-checkout-01: the user must resubmit after a provider timeout', () => { /* … */ });
```

```python
# covers BUG-orders-02
def test_orders_total_includes_tax():
    ...
```

Writes `test-cases.md` and `traceability.md`, and reports three gaps:

| Gap | Means | Who acts |
|---|---|---|
| Requirement with no test | Behaviour someone agreed to, that nothing checks | Whoever owns the surface |
| Test citing an unknown id | A broken link — a typo, or a requirement deleted underneath it | Whoever wrote the test |
| Behaviour mapping to neither | A surface the model described and nobody confirmed | Anyone — start with `docgen ask` |

The third is the largest gap and the least visible: there is no requirement to test against and no test that could fail.

---

## `docgen sync`

Bring every generated file up to date. No model, no cost.

```bash
docgen sync
docgen sync --dry-run
docgen sync --json
```

| Flag | Effect |
|---|---|
| `--dry-run` | Report what would change without writing. |
| `--json` | Machine-readable output on stdout. |

Re-renders from the current code and the committed cards and answers, writes only files whose bytes actually differ, and deletes pages for surfaces that no longer exist.

It deliberately does not re-infer. Inference costs money and belongs to `bootstrap`. The routine command has to be the cheap one, or it gets removed from CI.

---

## `docgen check`

The CI gate. Fails when the committed documentation no longer matches the code.

```bash
docgen check
docgen check --base origin/main
docgen check --strict
docgen check --json
```

| Flag | Effect |
|---|---|
| `--base <ref>` | Git comparison base for change-scoped plan and handoff policies. |
| `--as-of <timestamp>` | Override exception evaluation time for reproducible audits. |
| `--strict` | Also fail on unanswered questions and untriaged answers. |
| `--json` | Machine-readable output on stdout. |

Never calls a model, so it costs nothing per pull request and cannot be flaky. Three kinds of drift are reported separately:

| Kind | Means |
|---|---|
| `changed` | A generated file would be rewritten — usually the code changed, or someone hand-edited the output. |
| `missing` | A generated file should exist and does not. |
| `orphaned` | A file documents something that no longer exists. Worse than stale, because nothing about it looks wrong. |

Fix with `docgen sync` and commit the result.

`--strict` is right for a pilot repo with a drained question queue. It is the wrong default for a fleet-wide rollout: it fails every repository on day one, and a gate that fails everywhere gets disabled in week one.

---

## `docgen policy`

Evaluate configured governance rules without invoking a model:

```bash
docgen policy check --base origin/main
docgen policy check --base HEAD --json
```

The same evaluation is included in `docgen check`; this command provides
policy-focused diagnostics. Change-scoped policies fail clearly when `--base`
is omitted.

```bash
docgen policy exception add checkout-plan-delay \
  --policy changed-feature-plan \
  --subject checkout \
  --owner payments@example.com \
  --reason "Architecture review scheduled" \
  --expires 2026-08-20T18:00:00.000Z
docgen policy exception list
```

Exceptions are stored in `docs/.governance/exceptions.json`. IDs are immutable;
owner, reason, and future expiry are mandatory. Expired entries remain
auditable but stop suppressing failures.

---

## `docgen legacy inventory`

Inventory existing prose without treating any statement in it as fact. Markdown,
MDX, reStructuredText, AsciiDoc, and text files are hashed and labelled by
ownership. Human-authored documents remain `unreviewed`; only exact byte
duplicates are classified automatically. Local Markdown links are recorded as
existing or missing references. Explicit file links and exact inline-code
identifiers are mapped to graph nodes. Each candidate line is reported as
`mapped`, `ambiguous`, or `unmapped`, and the document receives a separate
evidence status. Mapping means “about this entity”; it never means that the
surrounding prose is true.

```bash
docgen legacy inventory
docgen legacy inventory --json
docgen legacy inventory --write
```

The default command is read-only. `--write` creates
`docs/.legacy/migration.json` once with every human document in a pending-review
state. It refuses to overwrite the manifest, and every move/archive decision
requires approval. The manifest records the canonical evidence-graph hash used
for claim mappings, so a later code state cannot silently inherit old evidence.
This command never moves, rewrites, or deletes a legacy file.

| Flag | Effect |
|---|---|
| `--write` | Create the versioned human-review migration manifest. |
| `--json` | Return the complete inventory and safety counters. |

Semantic status is an attributed review decision, not an automatic consequence
of finding a graph node:

```bash
docgen legacy classify docs/old-api.md contradicted \
  --reason "The referenced endpoint was removed" \
  --replacements docs/generated/features/api.md
```

Valid classifications are `current`, `partial`, `contradicted`, `orphaned`,
and `unverifiable`; byte-identical `duplicate` documents are detected during
inventory. The command verifies the document hash and evidence-graph hash,
records the reviewer and timestamp in immutable history, and resets the
proposed action to approval-pending. Defaults are `retain` for current,
`replace` for partial/contradicted, `archive` for orphaned, and `review` for
unverifiable. `--action` can override the proposal, but cannot approve it.

| Flag | Effect |
|---|---|
| `--reason <text>` | Required evidence or human reasoning for the decision. |
| `--action <action>` | Override the proposed `review`, `retain`, `replace`, or `archive` action. |
| `--replacements <paths>` | Comma-separated generated pages intended to replace the old document. |
| `--json` | Return the recorded transition and safety counters. |

Generate derived operation plans after classifications or replacement files
change:

```bash
docgen legacy plan
```

This writes `docs/.legacy/replacement-plan.json` and
`docs/.legacy/archive-plan.json`. Replacement entries are not approval-ready
until every named replacement exists. Archive entries are not executable until
the matching manifest decision is approved; replacement actions also require
all replacement files to exist.

Approval and execution are separate commands:

```bash
docgen legacy approve docs/old-api.md \
  --reason "Replacement reviewed by API owner"
docgen legacy archive docs/old-api.md
```

Approval rechecks the original document hash and evidence-graph hash and appends
attributed approval history. Archive repeats those checks, rejects symlinks and
existing targets, and moves the file to
`docs/legacy-archive/<original-path>`. It then records the source hash, actor,
timestamp, and target in the authoritative migration manifest. If the manifest
update fails, Docgen attempts to move the document back. There is no legacy
delete command.

---

## `docgen security scan`

Inspect dependency manifests and lockfiles without installing packages, calling
a registry, or using a model.

```bash
docgen security scan
docgen security scan --json
docgen security scan --strict
```

The npm scanner checks lockfile coverage, registry archive integrity, insecure
HTTP downloads, non-registry direct dependencies, and install-time scripts. The
Python scanner checks exact `==` pins and `--hash` constraints in
`requirements.txt`. Unsupported formats such as pnpm, Yarn, Poetry, Cargo, Go,
and Bundler are emitted as explicit gaps.

| Flag | Effect |
|---|---|
| `--json` | Machine-readable components, findings, gaps, and coverage limits. |
| `--strict` | Fail when any finding or unsupported-format gap exists. |

This is an offline reproducibility and provenance scan. It deliberately reports
`vulnerabilityCoverage.status: "not-evaluated"`; run a current ecosystem
advisory scanner in CI for CVEs.

## `docgen security sbom`

Generate a deterministic CycloneDX 1.6 inventory from the same offline scan.

```bash
docgen security sbom
docgen security sbom --out artifacts/sbom.cdx.json
docgen security sbom --json > sbom.cdx.json
docgen security sbom --dry-run
```

The default tracked destination is `docs/.security/sbom.cdx.json`. Repeating the
command against unchanged manifests and lockfiles produces identical bytes and
the same deterministic serial number. `--json` prints the SBOM to stdout and
does not write a file.

| Flag | Effect |
|---|---|
| `-o, --out <path>` | Override the SBOM destination. |
| `--dry-run` | Build and report the SBOM without writing it. |
| `--json` | Print the CycloneDX document on stdout instead of writing it. |

The repository-wide security assumptions and severity model are in
[`security/threat-model.md`](security/threat-model.md).

---

## `docgen status`

One repository's documentation health, in one screen. No model, no cost.

```bash
docgen status
docgen status --json
```

| Flag | Effect |
|---|---|
| `--json` | Machine-readable output on stdout. |

The report includes documentation coverage and drift plus evidence-graph node,
edge, and gap counts. It also shows the feature, critical-feature, plan, and
attributed-change records used by impact analysis and governance. JSON output
exposes these values under `graph`. Every count is paired with what it counts,
and the last line names the single next step.

---

## `docgen fleet`

One dashboard across many repositories.

```bash
docgen fleet ../repo-a ../repo-b
docgen fleet ../*/ --out ~/docgen-fleet.md
docgen fleet ../*/ --json
```

| Argument | |
|---|---|
| `paths...` | Repository roots to inspect. |

| Flag | Effect |
|---|---|
| `-o, --out <path>` | Where to write the dashboard. Default: `docgen-fleet.md`. |
| `--json` | Machine-readable output on stdout instead of writing a file. |

The generated Markdown has separate repository-health and evidence-governance
tables. Fleet totals come from each repository's extracted graph; Docgen does
not invent a composite health score.

Deliberately not a score. It shows the size of each gap and the next action per repo. A repository that cannot be read is listed as such rather than omitted — an absent row reads as "nothing to do here".

---

## `docgen session`

The common lifecycle used by Codex, Claude Code, Cursor, and generic coding
agents.

```bash
docgen session start --json
docgen session after-edit --base HEAD --json
docgen session end --base origin/main --json
```

`start` refreshes evidence and returns active plans and open questions.
`after-edit` refreshes the incremental index and computes change impact. `end`
synchronizes generated documentation, writes the tester handoff, and runs the
deterministic gate. Add `--strict` to enforce unresolved questions and triage.

---

## `docgen mcp`

Run the stdio MCP server used by supported coding agents. `docgen init` adds it
to generic `.mcp.json` and, where Codex is detected, `.codex/config.toml`. Tools:
`graph_search`, `graph_explain`, `graph_path`,
`change_impact`, `plans_list`, `plan_show`, `questions_list`, and
`handoff_generate`. Only `handoff_generate` writes a file; use its `dryRun`
argument for a read-only preview.

---

## `docgen init`

Make the question queue reachable from the tools the team already uses.

```bash
docgen init
docgen init --all
docgen init --hooks
```

| Flag | Effect |
|---|---|
| `--all` | Install every adapter, not only the ones this repo shows evidence of. |
| `--hooks` | Install the opt-in pre-push check. Existing hook ownership is never replaced. |

| Adapter | Written when |
|---|---|
| `AGENTS.md` | Always. The one file every current coding agent reads. |
| `.agents/skills/govern-documentation/SKILL.md` | Always. Portable generic agent skill. |
| `.codex/config.toml` | The repo uses Codex, or `--all`; adds the project-scoped MCP server with write-tool approval. |
| `CLAUDE.md` | The repo has `.claude/` or `CLAUDE.md`. |
| `.claude/skills/govern-documentation/SKILL.md` | The repo uses Claude Code, or `--all`. |
| `.cursor/rules/docgen.mdc` | The repo has `.cursor/`. |
| `.mcp.json` | Always. Existing servers and unrelated fields are preserved. |
| `.github/workflows/docgen.yml` | The repo has `.github/workflows/`. |
| `.github/dependabot.yml` | docgen is a local dependency **and** the repo has no update policy of its own. |
| `.githooks/pre-push` | Only with `--hooks`; runs the non-mutating `docgen check`. |

Shared Markdown adapters write a delimited block and preserve everything
outside it. Docgen-owned skill, Cursor, workflow, and hook files are
deterministic; MCP configuration is merged without removing unrelated settings.
Repeat runs are no-ops.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Any error — bad config, missing root, drift found by `check`, gaps under `trace --strict`, unreadable input. |

Errors print what went wrong, the file involved when there is one, and a specific remedy.
