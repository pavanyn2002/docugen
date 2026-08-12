# Docugen 1.0.0 release readiness

Assessment date: 2026-08-12
Decision owner: pavanyn2002
Status: release candidate — local gates passed; publication recorded separately

## Release criteria

| # | Criterion | Evidence | Result |
| ---: | --- | --- | --- |
| 1 | Undocumented repository produces a code-grounded baseline | Approved frontend/backend pilots and `extract` output | Pass |
| 2 | Legacy documents receive retained, replaced, or approved archive decisions | Legacy inventory, mapping, manifest, approval, and apply tests | Pass |
| 3 | Diffs identify features, docs, requirements, and tests | Impact summary and change-graph tests | Pass |
| 4 | Feature dates derive from Git | Feature history implementation and tests | Pass |
| 5 | Feature changes update plan, changelog, and handoff | Plan/change/handoff commands and tests | Pass |
| 6 | Critical inferred behaviour requires human confirmation | Governance policy evaluation tests | Pass |
| 7 | Requirements and bugs trace to tests | Requirement/test graph and traceability tests | Pass |
| 8 | CI blocks stale governance artifacts | Deterministic `check` and CI workflow tests | Pass |
| 9 | Claims have code evidence or human attribution | Graph provenance validation and exact model-citation enforcement | Pass |
| 10 | Static workflow operates without an LLM | `index`, `extract`, `sync`, `check`, `doctor`, and security gates | Pass |
| 11 | Incremental and clean builds agree | Partition equivalence tests and both real pilots | Pass |
| 12 | Supported agent integrations share one lifecycle | Adapter contract and generated-adapter tests | Pass |
| 13 | Privacy, security, dependency, and cross-platform gates pass | Redaction, policy, SBOM, recovery, CI matrix, and package checks | Pass |

## Representative pilots

| Repository | Class | Commit | Overall precision | Overall recall |
| --- | --- | --- | ---: | ---: |
| Docugen | library | release working tree | 100.0% | 100.0% |
| vercel/nextjs-postgres-auth-starter | frontend | `fde8ecf1` | 100.0% | 85.7% |
| gothinkster/node-express-realworld-example-app | backend | `30b68e1e` | 100.0% | 85.7% |

The application pilots each record one conservative Node runtime false negative
because neither upstream repository declares `engines.node`. The backend pilot
initially exposed a false Express router-mount warning; it was fixed and the
approved result was regenerated before release.

## Publication boundary

The immutable `v1.0.0` tag must point at the release commit. Pushing the tag
triggers `.github/workflows/release.yml`, which verifies the version, runs all
tests, builds, inspects package contents, emits a CycloneDX SBOM, publishes
`@tatvaops/docgen@1.0.0` through npm trusted publishing with OIDC and
provenance, and creates the GitHub Release with the SBOM attached. The npm
trusted-publisher relationship and GitHub `npm` environment must already be
configured by the repository owner.
