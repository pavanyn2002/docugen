# Build prompt: `docgen` — codebase documentation engine

## 1. Context

We run multiple products built at speed with AI coding assistants and minimal process. The situation today:

- No usable documentation across any product.
- No written requirements or specs — features arrived as ad-hoc requests.
- Neither developers nor QA can reliably say whether a given behavior is intended or a bug.
- Developers, when asked by QA, have been handing over AI-generated answers with no verification. Those answers become QA's de facto spec.
- Developers will not write documentation by hand. Treat this as a hard constraint, not a problem to solve with policy.

We are building an internal tool called `docgen` to fix this.

## 2. What we are building

A platform-neutral CLI that:

1. **Extracts** everything derivable from code deterministically (routes, DB schema, dependencies, endpoints, jobs, config) and renders it as markdown and Mermaid diagrams.
2. **Infers** feature-level behavior descriptions using an LLM, tagged with a confidence level, never presented as fact.
3. **Asks** developers targeted questions whenever intent cannot be determined from code, routes them to the right person by `git blame`, and merges the answers back as permanent ground truth.
4. **Regenerates** only the affected docs when code changes, and commits them into the same PR.

## 3. The one non-negotiable design principle

Every generated statement belongs to exactly one of three **trust lanes**, and the lanes are never mixed in the same file or paragraph:

| Lane | Source | Confidence | Maintenance |
|---|---|---|---|
| `verified` | Static analysis of code, or a human answer on record | Fact | Auto-regenerated / permanent |
| `inferred` | LLM reading the codebase | Plausible, unverified | Regenerated, always badged |
| `unknown` | LLM could not determine | Not a fact | Becomes a question |

Every generated markdown file carries a front-matter `confidence` field, and every section that is `inferred` or `unknown` carries a visible inline badge. **The tool must never emit an unbadged behavioral claim.** This is the entire point of the project — it is what stops the fabrication loop.

If you are ever unsure which lane something belongs in, it is `unknown`.

## 4. Architecture

Portability is achieved by putting all logic in a neutral CLI. IDE integrations are thin shims that shell out to it. Nothing intelligent lives in a Cursor rule or a Claude Code command.

```
packages/docgen/
  src/
    extract/       # static analysis. NO LLM CALLS EVER IN THIS DIRECTORY.
      routes.ts
      schema.ts
      deps.ts
      endpoints.ts
      jobs.ts
      config.ts
    surface/       # chunk the codebase into "surfaces"
    infer/         # LLM passes (Phase 1)
    questions/     # unknown queue, blame routing, answer merge (Phase 1)
    render/        # markdown + mermaid writers
    trace/         # traceability matrix (Phase 3)
    agents/        # pluggable LLM backends (Phase 1)
      claude.ts    # shells out to `claude -p`
      codex.ts     # shells out to `codex exec`
      cursor.ts    # shells out to `cursor-agent`
      api.ts       # direct API call
    adapters/      # AGENTS.md, .cursor/, .claude/, CI (Phase 4)
    cli.ts
  prompts/         # versioned prompt packs, plain .md files
  tests/
```

### Definition of a "surface"

A **surface** is the unit a QA person would ask a question about: one screen, one route, one API endpoint group, or one background job. Not one file. Not one function. Surface chunking is the hardest correctness problem in Phase 0 — get it right before anything else, and write tests for it.

## 5. Command surface

Phase 0 implements only the first two. Stub the rest with a "not implemented" message so the CLI shape is fixed early.

```
docgen extract                 # static lane only. No LLM. No cost. Must be fast.
docgen report                  # coverage summary, counts, gaps
docgen bootstrap               # Phase 1
docgen ask / answer / triage   # Phase 1-2
docgen sync                    # Phase 4
docgen check                   # Phase 4 — CI gate
docgen init                    # Phase 4 — install adapters
```

## 6. Phase 0 scope — build ONLY this

**Goal: a deterministic static documentation generator. Zero LLM calls. Zero token cost. Output that cannot be wrong.**

### 6.1 Extractors

Each extractor is an independent module exporting a pure function `(projectRoot: string) => Promise<ExtractResult>`. Each must degrade gracefully: if the project does not use that technology, return empty and log a skip, never throw.

| Extractor | Must produce |
|---|---|
| `routes` | Every user-facing route/screen: path, component/handler file, auth guards, dynamic params, layout |
| `schema` | Tables/collections, columns, types, nullability, relations, indexes |
| `deps` | Internal module dependency graph; flag cycles |
| `endpoints` | Every API endpoint: method, path, handler, request/response shape where statically knowable, auth |
| `jobs` | Cron jobs, queue consumers, workers, schedules |
| `config` | Every env var and feature flag, plus where each is read |

Use real parsers, not regex, wherever possible — AST-based tooling for the language, the ORM's own schema representation, the framework's route manifest. Regex is acceptable only as a last-resort fallback and must set `confidence: "low"` on that entry.

### 6.2 Output files

```
docs/generated/
  README.md          # index, generation timestamp, engine version, coverage summary
  routes.md
  api.md
  schema.md
  jobs.md
  config.md
  diagrams/
    sitemap.mmd
    erd.mmd
    modules.mmd
    integrations.mmd
```

Requirements for all generated output:

- Deterministic. Running twice on an unchanged repo produces byte-identical files. Sort everything; never emit timestamps except in `README.md`.
- Front matter on every file: `generated: true`, `engine_version`, `source_commit`, `confidence: verified`.
- A `<!-- docgen:generated -->` header comment warning against hand-editing.
- Mermaid emitted as `.mmd` text so it diffs in PRs and renders in GitHub and Notion.
- Every entry links back to `path/to/file.ts:42` so a reader can verify any claim in one click.
- Add `docs/generated/** linguist-generated=true` to `.gitattributes`.

### 6.3 Diagram rules

- `sitemap.mmd` — route tree from the router manifest
- `erd.mmd` — Mermaid `erDiagram` from the ORM schema
- `modules.mmd` — dependency graph; if more than 40 nodes, collapse to top-level directories and note the collapse
- `integrations.mmd` — external services inferred from HTTP clients, SDK imports, and env var names

Guard against unreadable output: if a graph exceeds the node budget, aggregate rather than emit a hairball.

### 6.4 `docgen report`

Prints, and writes to `docs/generated/README.md`:
- counts per extractor
- routes with no matching component file (dead routes)
- components not reachable from any route (orphans)
- tables not referenced anywhere in code
- env vars declared but never read, and read but never declared

These four gap lists are high-value on their own — they surface real rot immediately, before any LLM work.

## 7. Tech constraints

- **Language:** TypeScript, Node 20+
- **Distribution:** npm package, runnable via `npx @tatvaops/docgen`
- **Target codebases:** heterogeneous and not known ahead of time. The tool is handed to developers who run it on their own repo. Observed in-house shapes to prioritise: Next.js 15 App Router + React 19; Express 4 + Mongoose 5 + amqplib + swagger-jsdoc; React SPA on raw webpack; MedusaJS.
- **Repo layout of targets:** polyrepo, npm (one target uses yarn 4). Never assume a monorepo.
- **Config file:** `docgen.config.ts` at target repo root — extractor toggles, include/exclude globs, output dir, surface-chunking overrides
- No network calls in Phase 0
- Node built-ins and well-established parsers only; justify every new dependency

## 8. Working rules

1. Ask the section 9 questions before writing any code. Do not guess at the stack.
2. Build in this order, stopping for review after each: project scaffold + config loader + CLI shape → surface chunker + its tests → `routes` extractor → `schema` extractor → remaining extractors → renderers → diagrams → `report`.
3. Write tests as you go. Every extractor needs fixture-based tests using a small realistic sample project committed under `tests/fixtures/`. Determinism (same input → identical bytes) must be an explicit assertion.
4. No LLM calls anywhere in Phase 0. If a task seems to need one, that data belongs in Phase 1 — stop and say so instead.
5. Never fabricate. If an extractor cannot determine something, emit the entry with the field omitted and record it in a `gaps` array. Do not fill gaps with plausible values. This rule is the whole project in miniature.
6. Fail loudly on malformed input, silently on absent input. A missing Prisma schema means "skip, not applicable." A corrupt Prisma schema means "error, tell the user."
7. Keep the LLM boundary clean. Phase 0 code must have no imports from `infer/`, `questions/`, or `agents/`. Enforce with an import-boundary check.
8. ~~Run the extractors against a real repo~~ — superseded: the tool ships to developers who run it on their own repos. Compensate with fixtures modelled on the real in-house shapes listed in section 7.
9. Do not create documentation files about the project itself beyond a concise `README.md` and inline comments where logic is non-obvious.

## 9. Answers to the pre-build questions

1. **Target stack:** not fixed. Auto-detect per repo; degrade gracefully when a technology is absent.
2. **Monorepo or single package:** targets are polyrepo/npm. `docgen` itself lives in `packages/docgen`.
3. **Real repo to test against:** none. Developers run the plugin themselves.
4. **Route convention:** must support both file-system conventions and central router files, selected by detected framework.
5. **Existing OpenAPI/Swagger:** hybrid. AST is primary and authoritative; a declared spec is cross-checked and mismatches are reported as gaps. A spec is never trusted over code, because a stale annotation emitted as `verified` is exactly the fabrication this project exists to stop.
6. **`docs/generated/` committed?** Developers generate and commit it themselves. Default output path `docs/generated`, configurable.
7. **Hard-excluded directories:** defaults only (dependency, build, and VCS directories); per-repo additions via config.

---

## Phase 1 and beyond — not started

**Phase 1 — inference and questions.** Surface-level feature cards via LLM, each with what-it-does, user-visible behavior, states, inputs/outputs, edge cases found in code, and an explicit `unknowns[]` array. Confidence badging. Question queue with `git blame` routing. Multiple-choice question format including a "not mine / don't know" option. Slack delivery. Answers persisted to `docs/.answers/*.yaml` and injected as ground truth into every subsequent generation, flipping the corresponding section from `inferred` to `verified`. Pluggable agent backends so it runs on Claude Code, Codex, or Cursor CLI. Content-hash caching so unchanged surfaces never re-run.

**Phase 2 — triage and requirements.** Interactive `docgen triage` for working the unknown queue with a human. Output: numbered requirements with IDs and status, ADRs for real decisions, bug tickets for anything ruled a defect.

**Phase 3 — test cases and traceability.** Test-case skeletons generated from confirmed requirements and code branches, each mapped to a requirement ID. Traceability matrix: requirement → feature section → test case. Report the three gap classes: requirements with no test, tests with no requirement, behavior mapping to neither.

**Phase 4 — incremental and adapters.** `docgen sync` regenerating only diff-affected surfaces and committing into the PR. `docgen check` as a CI gate failing on doc drift and posting a PR comment listing every `inferred` claim created on that branch with confirm/reject checkboxes. Then adapters: `AGENTS.md` first (read natively by Cursor, Codex, and others), then `.cursor/` rules + commands + hooks, then `.claude/` equivalents.

**Phase 5 — fleet rollout.** `docgen init` across all repos, version pinning, automated update PRs, aggregate dashboard.

## Success criteria for Phase 0

- `docgen extract` runs on a real target repo in under 30 seconds
- Output is byte-identical across repeated runs
- Every route, table, endpoint, job, and env var in the target repo appears, with a source file and line
- All four diagrams render correctly in GitHub's Mermaid preview
- `docgen report` surfaces at least one genuine problem nobody knew about
- A QA engineer who has never seen the codebase can open `routes.md` and list every screen in the product
