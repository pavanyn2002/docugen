# docgen

Deterministic codebase documentation engine. Extracts what the code proves; never states what it cannot verify.

`docgen` reads a repository and generates markdown and Mermaid diagrams describing its routes, API endpoints, database schema, background jobs, module graph, and configuration. That part is entirely static: no LLM, no network, no token cost, and output that cannot be wrong because every statement traces to a source file and line.

On top of it, `docgen bootstrap` describes what each surface actually *does* — the part no parser can reach — and records every question it could not answer, routed to the developer who last touched the code.

## Why

Documentation written by hand rots. Documentation invented by a model is worse than none — it reads as fact and becomes QA's de facto spec. `docgen` separates the two:

| Lane | Source | Treated as |
|---|---|---|
| `verified` | Static analysis, or a human answer on record | Fact |
| `inferred` | An LLM reading the codebase | Plausible, always badged |
| `unknown` | Could not be determined | A question, never a claim |

The tool never emits an unbadged behavioural claim, and the two lanes cannot leak into each other: the static extractors are forbidden by an enforced import boundary from reaching the model at all.

## Coverage across stacks

`docgen` is meant to run on any repo, so it separates *recognising* a technology from *being able to parse* it. It detects the stack across every workspace in the repo — including `backend/` + `frontend/` splits with no root manifest — and says plainly what it could not read:

```
Detected stack
  3 workspaces
   ok SQL migrations in supabase/migrations/
  gap FastAPI in backend/
   ok Next.js in frontend/
warn  docgen cannot document 1 detected technology. The output below is
warn  incomplete — an empty section does not mean the repo has nothing there:
warn    FastAPI (backend/requirements.txt) — Python routes are not extracted.
```

This matters more than the parser coverage itself. An unsupported stack and a genuinely empty repo both produce an empty section, and a reader has no way to tell them apart unless it is stated.

| | Documented today |
|---|---|
| **Routes** | Next.js App Router, Next.js Pages Router, React Router |
| **Schema** | Prisma, Mongoose, SQL migrations (DDL), TypeORM, Sequelize, Django, SQLAlchemy |
| **Endpoints** | Express (incl. cross-file mounts), NestJS, Next.js route handlers and Pages API |
| **Recognised, not yet parsed** | Fastify, MedusaJS, FastAPI, Flask, Rails, Laravel, Spring Boot, MikroORM, Drizzle, Knex, GORM |

Adding a stack is a row in `src/detect/signatures.ts` plus a provider. Nothing else changes.

An existing OpenAPI or swagger spec is **cross-checked, never trusted**. Code is what runs; an annotation is a claim about the code that may have rotted. Endpoints present in code but missing from the spec, and spec entries with no handler behind them, are both reported.

Python models are read with pattern matching rather than a real parser — docgen is a Node tool and bundling a Python parser is not justified. Those entries are marked low-certainty and the run reports that they were read heuristically.

## Install

```bash
npx @tatvaops/docgen extract
```

Requires Node 20.11 or newer.

## Usage

```bash
docgen extract           # analyse and write docs/generated/ — no LLM, no network, no cost
docgen extract --dry-run # report what would be generated, writing nothing
docgen report            # coverage, plus findings that compare extractors against each other
docgen report --full     # the same, listing every item
```

`docgen extract` writes:

```
docs/generated/
  README.md      index, coverage summary, detected stack
  routes.md      every screen, with auth and params
  api.md         every endpoint, grouped by resource
  schema.md      tables and collections, fields, relations, indexes
  jobs.md        queue consumers, crons, scheduled tasks
  config.md      env vars: where read, where declared
  diagrams/      sitemap, erd, modules, integrations (Mermaid .mmd)
```

Output is byte-identical across runs, so regenerating produces no diff unless the code changed. The date in `README.md` comes from the source commit, not the clock, for the same reason.

Useful flags:

| Flag | Effect |
|---|---|
| `--cwd <path>` | target repo root (default: current directory) |
| `-c, --config <path>` | explicit config path (default: auto-discover) |
| `--only <ids>` | restrict to certain extractors, e.g. `routes,schema` |
| `-o, --out <path>` | override the output directory |
| `--dry-run` | analyse and report without writing files |
| `--full` | `report` only: list every finding rather than a preview |
| `--json` | machine-readable output on stdout |
| `--verbose` / `--quiet` | diagnostic level |

## Behaviour: what the code *does*

`docgen extract` documents structure. It cannot tell you what a screen is for, what happens when a payment times out, or whether an endpoint is meant to be public — none of that is in the syntax. That is what the second lane is for, and it is the only part that calls a model.

```bash
docgen init              # tell the coding agent in this repo about the question queue
docgen bootstrap         # infer a feature card per surface — this one costs money
docgen bootstrap --limit 5 --dry-run   # see what it would run, and which backends are available
docgen ask --mine        # the open questions on code you last touched
docgen answer <surface> <question-id> <answer>
```

`bootstrap` drives a coding CLI you have already signed in to — Claude Code, Codex, or Cursor Agent — so nobody needs a new API key. The direct Anthropic API is available as a CI fallback (`infer.agent: "api"`, with `@anthropic-ai/sdk` installed). An agent you configure explicitly and that turns out to be unavailable is an error, never a silent switch to a different model.

Everything it produces is badged on the line it appears on:

| Badge | Means |
|---|---|
| `verified` | a developer answered this, by name and date |
| `inferred` | a model wrote it from the code, with links to the lines it cites. Unchecked. |
| `unknown` | the model could not tell, so it asked instead of guessing |

A claim with no citation is rejected by the schema rather than published, and output that does not validate is discarded rather than salvaged into prose. A surface that could not be described is reported, not quietly omitted.

Answering is the point. `docgen answer` records the answer in `docs/.answers/` as ground truth: it is injected into every later generation, it survives regeneration and prompt changes, and the question is never asked again. `docgen init` puts the queue in front of whatever agent is already open in the repo, so the questions arrive when the developer still has the context to answer them.

```
docs/generated/behaviour.md     index: open questions per surface
docs/generated/behaviour/       one page per screen, endpoint group, or job
docs/.cards/                    inferred cards (data; regenerated)
docs/.answers/                  developer answers (ground truth; never regenerated)
```

Commands for later phases (`triage`, `sync`, `check`) are registered but exit non-zero with a "not implemented" message, so CI wired against them fails rather than silently passing.

## Configuration

Optional. A repo with no config works on defaults. To customise, add `docgen.config.ts` at the repo root:

```ts
import { defineConfig } from '@tatvaops/docgen/config';

export default defineConfig({
  outDir: 'docs/generated',
  exclude: ['src/legacy/**', 'src/generated-clients/**'],
  extractors: { jobs: false },
  diagrams: { maxNodes: 40 },
});
```

`.ts`, `.mts`, `.mjs`, `.js`, `.cjs`, and `.json` are all accepted. Unknown keys are rejected rather than ignored — a typo'd exclude glob would otherwise quietly produce wrong documentation.

## Findings

`docgen report` compares each extractor's output against the others. These are the checks that
tend to surface real rot:

| Finding | Compares |
|---|---|
| Routes with no component file | route declarations against the filesystem |
| Modules nothing imports | the module graph against itself, minus entry points and route files |
| Tables never mentioned outside their definition | schema names against a whole-word scan of the sources |
| Env vars declared but never read | `.env` files against `process.env` reads |
| Env vars read but never declared | the reverse |

Each states what it compared **and what it cannot prove**. "Nothing imports this module" is a
fact; "this module is dead code" is a conclusion that needs someone who knows whether it is
loaded dynamically. `docgen report` always exits 0 — findings are for a human to judge, and the
CI gate that fails a build is `docgen check` (Phase 4).

## Guarantees

- **Deterministic.** Same commit in, same bytes out — verified in CI on Node 20, 22, and 24.
  Sorting is locale-independent, paths are POSIX, line endings are LF, and the date in
  `README.md` comes from the source commit rather than the clock.
- **Two lanes, never mixed.** `extract` and `report` make no network call and cost nothing;
  `bootstrap` is the only command that calls a model, and it says so before it runs. Nothing
  a model produced is ever stamped `verified`, and nothing the static lane produced is ever
  badged as a guess.
- **No secrets.** Values are never read from `.env` files, only names and locations.
- **Diagrams parse.** Every generated `.mmd` is run through the real Mermaid parser in CI,
  not a lookalike.
- **Never fabricates.** Anything static analysis cannot establish is recorded as a gap.
  Anything the model cannot establish becomes a question. Neither is filled with a
  plausible value, and a claim with no citation is rejected rather than published.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck
npm run build
```

The `src/extract/`, `src/surface/`, and `src/render/` trees are the static lane and must never import from `src/infer/`, `src/questions/`, or `src/agents/`. This is enforced by a test, not a convention: output from the static lane is stamped `verified`, and a `verified` claim produced by a model is precisely the failure this tool exists to prevent.

See `SPEC.md` for the full design and phase plan.
