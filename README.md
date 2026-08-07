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
