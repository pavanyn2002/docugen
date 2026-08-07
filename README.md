# docgen

Deterministic codebase documentation engine. Extracts what the code proves; never states what it cannot verify.

`docgen` reads a repository and generates markdown and Mermaid diagrams describing its routes, API endpoints, database schema, background jobs, module graph, and configuration. Phase 0 is entirely static: no LLM, no network, no token cost, and output that cannot be wrong because every statement traces to a source file and line.

## Why

Documentation written by hand rots. Documentation invented by a model is worse than none — it reads as fact and becomes QA's de facto spec. `docgen` separates the two:

| Lane | Source | Treated as |
|---|---|---|
| `verified` | Static analysis, or a human answer on record | Fact |
| `inferred` | An LLM reading the codebase | Plausible, always badged |
| `unknown` | Could not be determined | A question, never a claim |

Phase 0 emits only `verified`. Later phases add the other two, always badged. The tool never emits an unbadged behavioural claim.

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
| **Recognised, not yet parsed** | Express, NestJS, Fastify, MedusaJS, FastAPI, Flask, Rails, Laravel, Spring Boot, MikroORM, Drizzle, Knex, GORM |

Adding a stack is a row in `src/detect/signatures.ts` plus a provider. Nothing else changes.

Python models are read with pattern matching rather than a real parser — docgen is a Node tool and bundling a Python parser is not justified. Those entries are marked low-certainty and the run reports that they were read heuristically.

## Install

```bash
npx @tatvaops/docgen extract
```

Requires Node 20.11 or newer.

## Usage

```bash
docgen extract           # static analysis only — no LLM, no network, no cost
docgen report            # coverage summary, counts, and gap lists
```

Useful flags:

| Flag | Effect |
|---|---|
| `--cwd <path>` | target repo root (default: current directory) |
| `-c, --config <path>` | explicit config path (default: auto-discover) |
| `--only <ids>` | restrict to certain extractors, e.g. `routes,schema` |
| `-o, --out <path>` | override the output directory |
| `--json` | machine-readable output on stdout |
| `--verbose` / `--quiet` | diagnostic level |

Commands for later phases (`bootstrap`, `ask`, `answer`, `triage`, `sync`, `check`, `init`) are registered but exit non-zero with a "not implemented" message, so CI wired against them fails rather than silently passing.

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

## Development

```bash
npm install
npm test          # vitest
npm run typecheck
npm run build
```

The `src/extract/`, `src/surface/`, and `src/render/` trees are the static lane and must never import from `src/infer/`, `src/questions/`, or `src/agents/`. This is enforced by a test, not a convention: output from the static lane is stamped `verified`, and a `verified` claim produced by a model is precisely the failure this tool exists to prevent.

See `SPEC.md` for the full design and phase plan.
