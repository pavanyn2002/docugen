# Docgen v1 implementation plan

Status: active
Target: a local-first documentation-governance CLI backed by an evidence graph.

## Product outcome

Docgen v1 must recover repositories whose documentation cannot be trusted and
then keep future code, feature plans, tester handoffs, requirements, and tests
connected. Code supplies evidence, models may draft interpretations, people
confirm intent, and CI prevents the lifecycle from being skipped.

## Source-of-truth layers

| Layer | Authority | Storage |
|---|---|---|
| Extracted code facts | Static parsers | Rebuildable evidence graph |
| Inferred behaviour | Model output with evidence | `docs/.cards/` |
| Developer answers | Named human | `docs/.answers/` |
| Requirements, bugs, decisions, context | Human triage | `docs/.requirements/` |
| Feature identity and intent | Developer-approved records | `docs/.features/`, `docs/.plans/` |
| Rendered documentation | Projection of the layers above | `docs/generated/` |

## Delivery phases

### 0. Product contract and migration safety

- [x] Define the v1 trust, determinism, ownership, and deletion rules.
- [x] Record the roadmap in the repository.
- [x] Add schema-version and compatibility policy tests.
- [x] Define the legacy-document migration manifest.

Gate: the application can state which artifacts are derived, inferred, or
human-owned and what it may rewrite or remove.

### 1. Evidence graph

- [x] Add graph node, edge, provenance, validation, and stable-id types.
- [x] Add deterministic graph construction and serialization.
- [x] Project current extractor results into the graph.
- [x] Expose the graph through the programmatic API and `RunResult`.
- [x] Add graph queries for search, neighbors, paths, and explanations.
- [x] Add a schema-validated, versioned on-disk index and atomic writes.
- [ ] Switch renderers to graph projections only after compatibility snapshots pass.

Gate: current generated documentation remains byte-identical while a clean
extraction produces a valid deterministic graph.

### 2. Symbol and incremental indexing

- [x] Add TypeScript/JavaScript function, class, method, containment, and direct-call edges.
- [x] Add inheritance, implementation, and typed property-call edges.
- [x] Add namespace imports, explicit/star barrel resolution, construction edges, and JSX references.
- [x] Expand general reference edges to remaining symbol-value uses without guessing.
- [x] Add a Tree-sitter adapter contract for additional languages.
- [x] Implement Python definitions, containment, inheritance, calls, and handler resolution with Tree-sitter.
- [x] Resolve extracted endpoint/job handlers and default route components to unique symbols.
- [x] Resolve statically proven Prisma, Django, and SQLAlchemy database access across files.
- [x] Resolve Bull, BullMQ, and amqplib producers to extracted consumers across files.
- [x] Hash scoped files and persist deterministic added/changed/deleted fingerprints.
- [x] Partition graph evidence by file and invalidate reverse dependency closures.
- [x] Reuse unaffected partitions with automatic clean-build fallback.
- [x] Skip extraction entirely on a verified no-change cache hit, with config, engine, and symbol-mode invalidation.
- [x] Scope every extractor result and symbol emission to requested partitions instead of also computing a clean reference.
- [x] Prove scoped reconstruction equals a clean graph in equivalence regressions and reject mutated reused partitions at runtime.

Gate: a changed file can be connected to downstream features without an LLM.

### 3. Features, Git history, and change impact

- [x] Add stable, human-owned feature records and rename aliases.
- [x] Derive file introduction and last-change dates from Git commits.
- [x] Aggregate evidence-file history into stable feature dates.
- [x] Add owners and criticality.
- [x] Implement baseline-aware `docgen impact` for working-tree and branch changes.
- [x] Implement immutable, attributed `docgen change` records from Git comparisons.
- [x] Connect changed files to current and previous graph entities.
- [x] Connect changes to registered features through graph membership.
- [x] Connect changes to requirements, tests, and generated pages.

Gate: a branch diff reports every documentation and testing surface it affects.

### 4. Planning, changelogs, and tester handoffs

- [x] Add human-owned plan records, stable acceptance IDs, and audited lifecycle commands.
- [x] Generate feature overview, implementation, plan, acceptance, and changelog pages.
- [x] Generate tester handoffs from the branch diff, graph, feature records, and plans.
- [ ] Ground model context in graph neighborhoods and exact source evidence.
- [x] Show a file/byte/provider disclosure before any model call.

Gate: every feature change can produce a tester-ready handoff without asking the
tester to understand the implementation.

### 5. Legacy-document recovery

- [x] Inventory existing documents without treating them as facts.
- [x] Map legacy claims and references to graph entities.
- [x] Classify current, partial, contradicted, duplicate, orphaned, and unverifiable docs.
- [x] Generate replacement and archive manifests.
- [x] Require approval before moving or deleting human-authored documents.

Gate: every old document is retained, replaced, or archived with an auditable reason.

### 6. Agent and editor integrations

- [x] Define common session-start, after-edit, and session-end operations.
- [x] Add Codex, Claude Code, Cursor, and generic skill adapters.
- [x] Add MCP tools for graph queries, impact, plans, questions, and handoffs.
- [x] Add optional Git hooks.
- [x] Keep CI as the universal enforcement boundary.

Gate: supported agents follow the same lifecycle and an interrupted agent cannot
silently bypass the pull-request gate.

### 7. Governance, privacy, and fleet operation

- [x] Add policy rules for plans, handoffs, critical feature verification, and tests.
- [x] Add time-bounded policy exceptions with owner and reason.
- [x] Redact secrets and add provider/model allowlists and local-only mode.
- [x] Add repository and fleet dashboards from the same graph.
- [x] Add dependency scanning, SBOM generation, and a threat model.

Gate: CI evaluates deterministic governance policies without network or model access.

### 8. Production hardening and v1 release

- [x] Test Windows, Linux, and macOS across supported Node versions.
- [x] Add graph golden tests, interrupted-write recovery, upgrade, and rollback tests.
- [ ] Pilot against representative real repositories and record false positives/negatives.
- [x] Add package provenance, automated releases, schema migrations, and `docgen doctor`.
- [ ] Publish v1 only after all release criteria below pass.

Current pilot evidence: the Docgen library self-pilot is committed as a draft.
The release gate remains open until a maintainer approves it and representative
frontend and backend application repositories have attributed reviews.

## v1 release criteria

1. An undocumented repository can produce a code-grounded baseline.
2. Legacy documents are mapped to a replacement, retention, or approved archive decision.
3. A code diff identifies affected features, documentation, requirements, and tests.
4. Feature dates are derived from Git rather than regeneration time.
5. Feature changes update a plan, changelog, and tester handoff.
6. Critical inferred behaviour requires human confirmation.
7. Requirements and bugs trace to tests.
8. CI blocks missing or stale governance artifacts.
9. Every claim has code evidence or human attribution.
10. Indexing, synchronization, and CI work without an LLM.
11. Incremental and clean builds produce the same graph and documentation.
12. Codex, Claude Code, Cursor, and generic integrations complete the same lifecycle.
13. Privacy, security, dependency, and cross-platform release checks pass.

## Explicit non-goals for the first release

- Do not infer business intent from completed code and label it verified.
- Do not call a model from `check`, `sync`, or static indexing.
- Do not delete human-authored legacy documents automatically.
- Do not support every programming language before the governance workflow works.
- Do not build graph visualization before path, impact, and evidence queries are useful.
