# @tatvaops/docgen

Documentation that cannot lie.

`docgen` reads a repository and writes down what it finds — routes, endpoints, database schema, background jobs, configuration — with every statement linked to the file and line it came from. Then it asks a language model what each of those things *does*, badges every word of that as unverified, and turns everything the model could not work out into a question routed to the developer who last touched the code.

Answering a question is one command. That answer becomes permanent, and the question is never asked again.

```bash
npx @tatvaops/docgen init        # tell the coding agent in this repo about it
npx @tatvaops/docgen extract     # structure — free, no model, no network
npx @tatvaops/docgen bootstrap   # behaviour — uses a coding CLI you already have
npx @tatvaops/docgen ask --mine  # the questions waiting on you
```

Node 20.11 or newer. Nothing else — `bootstrap` drives a coding CLI you have already signed in to (Claude Code, Codex, or Cursor Agent), so nobody needs a new API key.

## Why

Documentation written by hand rots. Documentation invented by a model is worse than none — it reads as fact and becomes QA's de facto spec. Every line docgen writes belongs to exactly one lane, and the lane is visible on the line:

| Lane | Where it came from | How to treat it |
|---|---|---|
| `verified` | A parser reading real code, or a named developer's answer on record | Fact |
| `inferred` | A model reading the codebase, with links to the lines it cites | A starting point. Unchecked. |
| `unknown` | Could not be determined | A question — never a claim |

The static lane is forbidden by an enforced import boundary from ever reaching a model. A claim with no citation is rejected by the schema rather than published. Anything the model cannot establish becomes a question instead of a guess.

## Commands

| | |
|---|---|
| `extract` | Static analysis. Free. |
| `report` | Coverage and cross-extractor findings. Free. |
| `bootstrap` | Infer behaviour. **The only command that costs money.** |
| `ask` | The open question queue. Free. |
| `answer` | Record an answer as ground truth. Free. |
| `triage` | Classify answers into requirements, defects, and decisions. Free. |
| `trace` | Link requirements to the tests that check them. Free. |
| `sync` | Bring every generated file up to date. Free. |
| `check` | CI gate: fail when the docs are stale. Free. |
| `status` | This repo's documentation health. Free. |
| `fleet` | One dashboard across many repositories. Free. |
| `init` | Install the agent and CI adapters. Free. |

Run `docgen <command> --help` for flags.

## Output

```
docs/
  generated/            regenerated; never hand-edit
    README.md           index, coverage, detected stack
    routes.md           every screen, with auth and params
    api.md              every endpoint, grouped by resource
    schema.md           tables, fields, relations, indexes
    jobs.md             crons, queue consumers, scheduled tasks
    config.md           env vars: where read, where declared
    behaviour.md        what each surface does (inferred)
    behaviour/          one page per screen, endpoint group, or job
    requirements.md     what a developer confirmed (verified)
    test-cases.md       one case per confirmed requirement
    traceability.md     requirement → test, and what is not covered
    diagrams/           sitemap, ERD, modules, integrations (Mermaid)
  .cards/               model output (data, regenerated)
  .answers/             developer answers (ground truth, never regenerated)
  .requirements/        triaged decisions (ground truth, never regenerated)
```

Commit all of it. The cards make the next run cheap; the answers make the documentation true.

## Coverage across stacks

docgen separates *recognising* a technology from *being able to parse* it. It detects the stack across every workspace — including `backend/` + `frontend/` splits with no root manifest — and says plainly what it could not read, because an unsupported stack and a genuinely empty repo otherwise look identical:

```
Detected stack
  3 workspaces
   ok SQL migrations in supabase/migrations/
  gap FastAPI in backend/
   ok Next.js in frontend/
warn  docgen cannot document 1 detected technology. The output below is
warn  incomplete — an empty section does not mean the repo has nothing there.
```

| | Documented today |
|---|---|
| **Routes** | Next.js App Router, Next.js Pages Router, React Router |
| **Schema** | Prisma, Mongoose, SQL migrations (DDL), TypeORM, Sequelize, Django, SQLAlchemy |
| **Endpoints** | Express (incl. cross-file mounts), NestJS, Next.js route handlers and Pages API |
| **Recognised, not yet parsed** | Fastify, MedusaJS, FastAPI, Flask, Rails, Laravel, Spring Boot, MikroORM, Drizzle, Knex, GORM |

An existing OpenAPI or Swagger spec is **cross-checked, never trusted**. Code is what runs; an annotation is a claim about the code that may have rotted. Endpoints present in code but missing from the spec, and spec entries with no handler behind them, are both reported.

Python models are read by pattern matching rather than a real parser — docgen is a Node tool and bundling a Python parser is not justified. Those entries are marked low-certainty and the run says they were read heuristically.

## Configuration

Optional; defaults work on most repositories. To customise, add `docgen.config.ts` at the repo root:

```ts
import { defineConfig } from '@tatvaops/docgen/config';

export default defineConfig({
  exclude: ['src/legacy/**'],
  extractors: { jobs: false },
  infer: { agent: 'claude', maxFilesPerSurface: 16 },
});
```

Unknown keys are rejected rather than ignored, so a typo fails loudly.

## Guarantees

- **Deterministic.** Same commit in, same bytes out — verified in CI on Node 20, 22, and 24. Sorting is locale-independent, paths are POSIX, line endings are LF, and dates come from the source commit rather than the clock.
- **Two lanes, never mixed.** Only `bootstrap` calls a model, and it says so before it runs. Nothing a model produced is ever stamped `verified`.
- **No secrets.** `.env` values are never read or recorded — only variable names and where they are used.
- **Never fabricates.** Gaps are recorded, unknowns become questions, and neither is filled with a plausible value.
- **Diagrams parse.** Every generated `.mmd` is run through the real Mermaid parser in CI, not a lookalike.

## Documentation

Full guides live in the repository under `docs/`:

| Guide | For |
|---|---|
| Getting started | Your first run, in about five minutes |
| The trust model | What each badge guarantees |
| Command reference | Every command, every flag |
| For developers | The daily loop: answering questions without writing docs |
| For QA | How to read the output |
| Configuration | Every option, and when you need it |
| CI and automation | The drift gate |
| Rolling out across repos | Handing this to a team and many repositories |
| Troubleshooting | When something looks wrong |

## Licence

See `LICENSE`.
