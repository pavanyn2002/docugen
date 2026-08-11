# Docgen v1 product contract

This contract defines the non-negotiable behavior of the documentation-governance
application. Features that violate it are defects even when their output looks useful.

## Trust

1. Extracted facts come only from deterministic parsers reading repository evidence.
2. Inferred claims are labeled `inferred`, cite evidence, and never become verified by repetition.
3. Human claims record who supplied them and when.
4. Missing evidence creates a gap or question, never a plausible value.
5. Unsupported technology is reported as a coverage limitation.

## Determinism

1. Static output is a function of committed source, configuration, and human records.
2. Code dates come from Git commits, not the wall clock used to run Docgen.
3. Ordering and line endings are platform-independent.
4. A clean rebuild is the CI reference implementation.
5. Incremental indexes must be equivalent to a clean rebuild.

## Artifact ownership

1. Docgen may rewrite files explicitly marked as generated.
2. Feature cards are model-owned caches and must not be hand-edited.
3. Answers, requirements, plans, decisions, and approved exceptions are human-owned records.
4. Human-owned records are changed only by explicit commands or direct human edits.
5. Human-authored legacy documents are never deleted or moved without an approved manifest.

## Privacy and cost

1. Static indexing, rendering, status, and CI do not use a network or model.
2. Model calls state the provider, selected files, and byte count before transmission.
3. Secret values and ignored files are excluded from model context.
4. A local-only mode disables every remote model path.
5. CI never needs credentials for an AI provider.

## Governance

1. Agent integrations improve the workflow but are not the enforcement boundary.
2. Git and CI detect whether affected documentation artifacts are current.
3. Policy failures explain the affected feature, evidence, and remediation.
4. Policy exceptions are attributed, justified, scoped, and time-bounded.
5. Tester handoffs distinguish verified acceptance criteria from inferred observations.

## Migration safety

1. New baseline documentation treats code as evidence and legacy documentation as an input to review.
2. Contradictions are reported; code and old prose are not silently reconciled.
3. Generated orphaned files may be removed by synchronization.
4. Human-authored legacy files require an explicit archive or deletion decision.
5. A migration report preserves the old-to-new document mapping.
