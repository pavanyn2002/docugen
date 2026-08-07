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
docgen check --strict
docgen check --json
```

| Flag | Effect |
|---|---|
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

## `docgen status`

One repository's documentation health, in one screen. No model, no cost.

```bash
docgen status
docgen status --json
```

| Flag | Effect |
|---|---|
| `--json` | Machine-readable output on stdout. |

Every count is paired with what it is a count of, and the last line names the single next step.

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

Deliberately not a score. It shows the size of each gap and the next action per repo. A repository that cannot be read is listed as such rather than omitted — an absent row reads as "nothing to do here".

---

## `docgen init`

Make the question queue reachable from the tools the team already uses.

```bash
docgen init
docgen init --all
```

| Flag | Effect |
|---|---|
| `--all` | Install every adapter, not only the ones this repo shows evidence of. |

| Adapter | Written when |
|---|---|
| `AGENTS.md` | Always. The one file every current coding agent reads. |
| `CLAUDE.md` | The repo has `.claude/` or `CLAUDE.md`. |
| `.cursor/rules/docgen.mdc` | The repo has `.cursor/`. |
| `.github/workflows/docgen.yml` | The repo has `.github/workflows/`. |
| `.github/dependabot.yml` | docgen is a local dependency **and** the repo has no update policy of its own. |

Markdown adapters write a delimited block and preserve everything outside it. A file with mangled or out-of-order markers is appended to rather than "repaired" — replacing everything between them would delete the team's own content in exactly that case. Repeat runs are no-ops.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Any error — bad config, missing root, drift found by `check`, gaps under `trace --strict`, unreadable input. |

Errors print what went wrong, the file involved when there is one, and a specific remedy.
