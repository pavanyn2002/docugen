# Troubleshooting

Every docgen error names what went wrong, the file involved when there is one, and a specific remedy. If one does not, that is a bug worth reporting.

## `extract` found nothing

```
Routes: not applicable
API endpoints: not applicable
```

**Check the detected stack first.** `docs/generated/README.md` lists what docgen recognised and what it cannot parse:

```
  gap FastAPI in backend/ — Python routes are not extracted.
```

A recognised-but-unparsed stack is a coverage gap, not an empty repo. docgen documents routes for Next.js (App and Pages Router) and React Router; endpoints for Express, NestJS, and Next.js handlers; schema for Prisma, Mongoose, SQL DDL, TypeORM, Sequelize, Django, and SQLAlchemy. Fastify, MedusaJS, FastAPI, Flask, Rails, Laravel, Spring Boot, Drizzle, Knex, and GORM are recognised but not yet parsed.

**Otherwise check your globs.** `docgen extract --verbose` shows which files were scanned. A stray `exclude` pattern or a source root the `include` globs do not reach is the usual cause.

## `No LLM backend is available`

```
error No LLM backend is available, so nothing can be inferred.
error   Set up any one of these, then re-run:
error     - Claude Code: Install Claude Code and run `claude` once to sign in.
error     - Codex CLI: Install the Codex CLI and run `codex login`.
```

`docgen bootstrap --dry-run` reports which backends were found. If one is installed but not detected, check it is on `PATH` in the same shell:

```bash
which claude    # or: where claude
```

For CI, install `@anthropic-ai/sdk`, set `ANTHROPIC_API_KEY`, and set `infer.agent: "api"`.

## `The configured agent backend 'x' is not available here`

Deliberate. An explicitly configured backend that is missing is an error rather than a silent fall back to a different model — switching models changes both what the documentation says and what it costs.

Either install that backend, or set `infer.agent: "auto"`.

## A surface could not be described

```
warn  2 surface(s) could not be described. No card was written for these —
warn  they are absent from the documentation, not empty in it:
warn    /checkout — Claude Code timed out after 180000ms
warn    /orders — The model's JSON did not match the required shape: summary.evidence — Array must contain at least 1 element(s)
```

Also deliberate. A surface docgen could not describe gets no page, rather than an empty one that reads as "nothing here".

- **Timeouts** — raise `infer.timeoutMs`, or lower `infer.maxFilesPerSurface` so there is less to read.
- **Schema mismatch** — the model returned a claim with no citation, which is rejected by design. Usually transient; re-run with `--force` for that surface. If it persists on one surface, it is normally too large or too tangled to reason about — narrow it with a `surfaces.overrides` entry.

## `docgen check` fails and I did not touch the docs

That is the gate working. Either the code changed, or something hand-edited a generated file.

```bash
docgen sync && git add docs/ && git commit -m "docs: sync"
```

If it fails again immediately after a sync, that is a bug — please report it with the `docgen check --json` output.

## `check` reports `orphaned` files

A generated page for something that no longer exists. `docgen sync` deletes them.

If a page you want is being called orphaned, its surface no longer exists as far as the chunker is concerned — usually because the code moved. A `surfaces.overrides` entry pins it.

## Answers are not showing as verified

Check three things, in order:

1. **The answer was recorded.** `docs/.answers/<surface>.yaml` should contain it.
2. **The surface id matches.** Answers are filed by surface id. If the surface was renamed — a route path changed, say — the old answer no longer attaches. Edit the `surfaceId` in the YAML; it is meant to be hand-editable.
3. **The pages were re-rendered.** `docgen answer` does this automatically, but a hand-edited answers file needs a `docgen sync`.

## `docs/.answers/x.yaml is not valid YAML`

Loud on purpose. These are recorded developer answers treated as ground truth, and silently skipping one would demote confirmed knowledge back to a guess without anyone noticing.

Fix the syntax. The most common cause is a hand-edited answer containing a `:` or a leading `#` without quoting.

## `docgen trace` says a requirement is untested but I wrote the test

The citation has to be findable. Check:

1. **The id is exact** — `REQ-checkout-01`, not `REQ-CHECKOUT-01` or `REQ-checkout-1`.
2. **The file matches the trace globs.** `docgen trace --json` reports `testFilesScanned`. If that number looks too low, widen `trace.include`.
3. **The id is in the file**, in a test name, a comment, a docstring — anywhere in the text.

## Interactive triage will not start

```
error Interactive triage needs a terminal, and this is not one.
```

You are in a pipe, a CI job, or an agent session without a TTY. Use the non-interactive form:

```bash
docgen triage --list --json
docgen triage <surface> <question-id> <kind>
```

## `Not a directory`

```
error Not a directory: /path/to/repo
```

A mistyped `--cwd`. This is an error rather than a silently empty result, because otherwise a typo looks exactly like a repository with no routes.

## Windows: a backend reports available then fails

Fixed in current versions, but the symptom was `spawn codex ENOENT` after the probe said `ok`. Most of these CLIs install as a `.cmd` shim on Windows, which Node cannot spawn directly. If you see it, you are on an old build — upgrade.

## Output differs between machines

It should not; that is verified in CI on three Node versions. If you see it:

- **Line endings.** docgen writes LF. A `.gitattributes` or editor rewriting to CRLF will show a diff on every run. `docgen init` adds the `linguist-generated` marker but does not manage `text=auto`.
- **Different engine versions.** Check `docgen --version` on both. This is why the CI gate pins one.

## Diagrams do not render

Every `.mmd` is validated against the real Mermaid parser in CI, so the file itself is parseable. If a viewer will not render it:

- GitHub renders Mermaid in fenced ` ```mermaid ` blocks in Markdown, not in standalone `.mmd` files. Paste the contents into a fence, or use a Mermaid-aware viewer.
- Very large graphs may hit a viewer's own limits. Lower `diagrams.maxNodes` to make docgen aggregate sooner.

## Getting more detail

```bash
docgen extract --verbose      # per-extractor and per-file diagnostics
docgen check --json           # exactly which files drift, and how
docgen status --json          # every count this repo reports
docgen report --full          # every cross-extractor finding
```
