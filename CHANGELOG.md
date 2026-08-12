# Changelog

All notable changes to Docugen are documented here.

## 1.0.3 — 2026-08-13

Targeted Express, OpenAPI, and secret-classification patch.

### Fixed

- Added deterministic application ownership for Express instances held on
  typed class properties, constructor assignments, property initializers, and
  statically provable aliases; direct class-property endpoints and imported
  router mounts now participate in the existing runtime-scoped analysis.
- Added conservative static evaluation for mount-prefix literals, constants,
  concatenation, templates, local literal objects, and provable imported
  defaults. Partial prefixes retain stable placeholders and produce structured
  `mount-prefix-unresolved` findings without orphaning the router.
- Associated inline OpenAPI/Swagger operations with router mount graphs and
  runtime applications, including multiple mounts/applications, while leaving
  genuinely ambiguous documents unannotated and deduplicating scope warnings
  per source document.
- Added a rendered and JSON OpenAPI comparison summary separating compared
  operations, both mismatch directions, skipped operations, and distinct
  ambiguous documents.
- Replaced broad secret-name substring matching with boundary-aware credential
  tokens, suppressing generic service-key defaults while no longer treating
  benign authentication URLs, certificate paths, or salt-round settings as
  secrets solely because of those words.

### Compatibility

- Conventional single-variable Express applications and their existing IDs
  remain unchanged. New class application identities, partial-prefix paths,
  OpenAPI source metadata, and summary fields are additive.
- v1.0.2 workspace scoping, schema anchors, Git diagnostics, write reporting,
  source links, dry-run behavior, and known credential-literal suppression are
  preserved.

## 1.0.2 — 2026-08-12

Patch-release hardening for multi-service repositories and generated-output
security.

### Fixed

- Suppressed secret-like and credential-shaped source defaults before they can
  enter extraction results, the evidence graph, JSON, or generated pages.
- Scoped endpoint identity and duplicate detection by workspace and runtime
  application, including Express router mount propagation and conservative
  handling of unmounted routers.
- Scoped OpenAPI cross-checks, schema identity/findings, and environment
  declarations to their owning workspaces.
- Added deterministic explicit schema anchors that remain unique across repeated
  names and case-colliding headings.
- Included created or modified `.gitattributes` files in JSON and human-readable
  write reports without reporting an already-correct file.
- Replaced the generic missing-Git warning with structured diagnostics for
  non-repositories, empty repositories, missing Git, timeouts, dubious
  ownership, permissions, and invalid HEAD state.

### Compatibility

- Single-workspace entry IDs and compact tables remain unchanged where no
  ownership collision requires a discriminator. New workspace/application
  fields are additive.

## 1.0.1 — 2026-08-12

First production release of the local-first documentation-governance CLI.

Version 1.0.0 was validated and tagged but did not reach npm because the new
package namespace had not yet been authenticated. Version 1.0.1 preserves that
tag, corrects the release bootstrap and cross-platform CI gates, and is the
first publishable v1 artifact.

### Included

- Public npm distribution under the personal scope `@pavanyn/docugen`.
- Deterministic structural documentation generated from an evidence graph.
- TypeScript/JavaScript and Python symbol indexing with incremental graph caches.
- Feature, plan, requirement, test, change-impact, and tester-handoff traceability.
- Graph-grounded optional model inference with exact source-citation enforcement.
- Legacy-document inventory, reviewed migration manifests, and safe archival workflow.
- Codex, Claude Code, Cursor, generic skill, MCP, Git-hook, and CI integrations.
- Governance policies, privacy controls, secret redaction, SBOMs, migrations,
  atomic writes, recovery tests, and cross-platform release automation.

### Validation

- Approved self, frontend, and backend pilot reports under `docs/pilots/`.
- 805 automated tests plus typecheck, build, deterministic drift, package,
  migration, recovery, and multi-platform CI gates.
- Source tests on Node 22 and 24 across Windows, Linux, and macOS, plus a packed
  CLI runtime test on the declared minimum Node 20.11 version.

### Known conservative gaps

- Next.js handlers that only re-export HTTP methods are reported as unknown.
- Drizzle schemas are detected but not structurally extracted.
- Node.js runtime detection requires explicit evidence; it is not inferred from
  JavaScript tooling alone.

## 1.0.0 — 2026-08-12 (unpublished)

Validated release candidate. Its immutable tag records the initial npm
publication attempt; no package or GitHub Release was created from it.
