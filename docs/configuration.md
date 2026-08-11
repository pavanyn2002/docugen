# Configuration

Optional. A repository with no config works on defaults, including monorepos with a `backend/` + `frontend/` split and no root manifest.

Reach for config when docgen is reading something it should not, missing something it should, or grouping surfaces in a way that does not match how your team talks about the product.

## Where it goes

At the repository root, one of:

```
docgen.config.ts     docgen.config.mts    docgen.config.mjs
docgen.config.js     docgen.config.cjs    docgen.config.json
```

Two config files present at once is an error, not a precedence puzzle — delete all but one.

```ts
import { defineConfig } from '@tatvaops/docgen/config';

export default defineConfig({
  exclude: ['src/legacy/**'],
});
```

`defineConfig` is only for types; a plain object works. In JSON, use the same keys.

Override the location with `--config <path>`. Unlike auto-discovery, a missing explicit path **is** an error.

## Everything you can set

```ts
export default defineConfig({
  // Where generated documentation goes, relative to the repo root.
  outDir: 'docs/generated',

  // Source globs to scan.
  include: ['**/*'],

  // Additional exclusions, on top of the ones that always apply.
  exclude: [],

  // Turn extractors off individually.
  extractors: {
    routes: true,
    endpoints: true,
    schema: true,
    jobs: true,
    config: true,
    deps: true,
  },

  diagrams: {
    // Above this many nodes a diagram aggregates instead of emitting a hairball.
    maxNodes: 40,
  },

  surfaces: {
    // Force specific files into one surface when the heuristics get it wrong.
    overrides: [],
    // Mount prefixes to strip before endpoints are grouped by resource.
    apiBasePaths: [],
  },

  openapi: {
    // 'cross-check' compares a declared spec against the code and reports
    // disagreements. 'ignore' does not read the spec at all.
    mode: 'cross-check',
    // Explicit spec path, when it is not in a conventional location.
    // path: 'docs/openapi.yaml',
  },

  // Where to look for tests citing a requirement id.
  trace: {
    include: ['**/*.{test,spec}.{ts,tsx,js,jsx}', '**/tests/**/*.py', /* … */],
  },

  // Opt in gradually. Enabled policies are enforced by `docgen check` in CI.
  governance: {
    policies: {
      changedFeaturesRequirePlan: false,
      changesRequireHandoff: false,
      criticalFeaturesRequireVerification: false,
      requirementsRequireTests: false,
    },
    criticalityAtLeast: 'critical', // 'high' | 'critical'
  },

  privacy: {
    localOnly: false,
    redactSecrets: true,
    allowedAgents: ['claude', 'codex', 'cursor', 'api'],
    // allowedModels: ['organization-approved-model-id'],
  },

  // Only these cost money, and only when `docgen bootstrap` runs.
  infer: {
    agent: 'auto',              // 'auto' | 'claude' | 'codex' | 'cursor' | 'api'
    // model: 'claude-opus-5',  // omit to use the backend's own default
    maxFilesPerSurface: 12,
    maxBytesPerFile: 24_000,
    maxBytesPerSurface: 120_000,
    timeoutMs: 180_000,
  },

  // Mark the output directory linguist-generated so it collapses in PR diffs.
  gitattributes: true,
});
```

Unknown keys are rejected rather than ignored, so a typo fails loudly instead of silently doing nothing.

## Always excluded

These cannot be switched off:

```
node_modules/  .git/  dist/  build/  out/  .next/  .nuxt/
.svelte-kit/  .turbo/  .cache/  coverage/  __snapshots__/  *.min.js
docs/generated/  docs/.cards/  docs/.answers/  docs/.requirements/
```

The last four matter: without them a second run would read the first run's output and feed it back into the results.

## When you actually need each option

### `exclude`

Vendored code, generated API clients, a legacy directory nobody maintains. Anything docgen documents that a reader should not be looking at.

```ts
exclude: ['src/generated-clients/**', 'vendor/**', 'src/legacy/**']
```

### `extractors`

Turn one off when it is producing noise rather than information — for example a repo with no meaningful background jobs where the jobs extractor picks up test scaffolding.

```ts
extractors: { jobs: false }
```

Note that a disabled extractor produces *no page*, which is different from an empty one. That distinction is deliberate.

### `surfaces.apiBasePaths`

docgen already strips `/api` and `/v1`-style version segments before grouping endpoints. Set this when your service mounts everything under something else and all endpoints would otherwise collapse into one surface named after the mount point:

```ts
surfaces: { apiBasePaths: ['/service/internal'] }
```

### `surfaces.overrides`

The chunker's heuristics will be wrong somewhere. This is the escape hatch that does not require a code change:

```ts
surfaces: {
  overrides: [
    {
      id: 'screen:onboarding',
      kind: 'screen',                 // 'screen' | 'endpoint-group' | 'job'
      title: 'Onboarding wizard',
      include: ['src/onboarding/**'],
    },
  ],
}
```

A title here is a label, not a claim. Keep it mechanical — "Onboarding wizard" is fine; "Onboarding wizard that validates VAT numbers" is a behavioural claim, which belongs in an answer.

### `openapi.mode`

There is deliberately no `trust-spec` mode. Code is what runs; an annotation is a claim about the code that may have rotted. Set `ignore` only when a spec is so stale that the cross-check output is pure noise — and treat that as a problem to fix, not to hide.

### `trace.include`

Widen this when `docgen trace` reports requirements as untested that you know are covered. A test directory the default globs miss is reported as a false gap, and a matrix with false gaps in it gets ignored.

```ts
trace: { include: ['**/*.{test,spec}.ts', 'qa/**/*.robot'] }
```

### `infer.*`

The context limits are the cost control. Raising `maxFilesPerSurface` gives the model more to work with and costs proportionally more per surface. When files are dropped to stay within budget, the prompt tells the model which ones were omitted, so it records an unknown rather than describing a surface it only partly saw.

Set `agent` explicitly when the team must all use the same backend. An explicitly named backend that is unavailable is an error, never a silent downgrade to a different model.

### `governance.*`

Enable policies one at a time after the repository has a usable baseline. The
change-scoped plan and handoff policies require `docgen check --base <revision>`;
the generated GitHub workflow supplies the pull-request base automatically.

- `changedFeaturesRequirePlan` requires an affected feature to have an approved,
  in-progress, or completed plan.
- `changesRequireHandoff` requires the tester handoff to name the exact base and
  changed file set.
- `criticalFeaturesRequireVerification` requires sufficiently critical active
  features to have an owner, matched code evidence, a behavior card, and no
  unanswered verification questions.
- `requirementsRequireTests` requires every confirmed testable requirement or
  bug to be cited by a test, and rejects citations to unknown requirements.

Record exceptions explicitly with an owner, reason, and expiry using
`docgen policy exception add`; permanent exceptions are unsupported.

### `privacy.*`

`redactSecrets` is enabled by default. Before a model call, Docgen replaces
private-key blocks, credential-bearing URLs, common provider tokens, JWTs, and
values assigned to password/token/secret/API-key fields. The disclosure printed
immediately before each call names the included files, total prompt bytes,
provider, model, and redaction count.

`allowedAgents` restricts which backend may receive repository context. When
`allowedModels` is present, `infer.model` becomes mandatory and must exactly
match one listed model id; Docgen never silently falls back to a different
model. `localOnly: true` disables model-backed inference entirely while leaving
indexing, synchronization, policy checks, and generated documentation working.

## Verifying your config took effect

```bash
docgen extract --dry-run --json
```

Shows what would be generated and which extractors ran, without writing anything. If a config change did nothing, check for a typo — but a typo in a *key* would have failed loudly, so the usual culprit is a glob that does not match.
