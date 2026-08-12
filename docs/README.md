# docgen documentation

Start with **[Getting started](getting-started.md)** — about five minutes, on any repository.

## By role

**You are setting this up for a team**
[Getting started](getting-started.md) → [The trust model](trust-model.md) → [Rolling out across repos](rollout.md) → [CI and automation](ci.md)

**You are a developer who was handed this**
[For developers](for-developers.md). One page; the rest is optional.

**You are QA reading the output**
[For QA](for-qa.md), then [The trust model](trust-model.md) for what the badges guarantee.

**You are looking for a specific flag**
[Command reference](commands.md).

**Something looks wrong**
[Troubleshooting](troubleshooting.md).

## All guides

| Guide | Covers |
|---|---|
| [Getting started](getting-started.md) | First run, from `extract` through answering a question |
| [The trust model](trust-model.md) | `verified` / `inferred` / `unknown`, and how they are kept apart |
| [Command reference](commands.md) | Every command, every flag, every exit code |
| [For developers](for-developers.md) | The daily loop and the cheat sheet |
| [For QA](for-qa.md) | Reading the output, and which parts are a specification |
| [Configuration](configuration.md) | `docgen.config.ts` and when you need one |
| [CI and automation](ci.md) | The drift gate, machine-readable output |
| [Rolling out across repos](rollout.md) | A sequence that survives contact with a real team |
| [Troubleshooting](troubleshooting.md) | Specific failures and what to do about them |
| [Docgen v1 implementation plan](implementation-plan.md) | Evidence graph, feature lifecycle, tester handoffs, migration, and release gates |
| [Docgen 1.0.0 release readiness](v1-release-readiness.md) | Criterion-by-criterion evidence, representative pilots, and publication boundary |
| [Schema compatibility and upgrades](schema-compatibility.md) | Version support, explicit migrations, backups, rollback, and recovery guarantees |
| [Security threat model](security/threat-model.md) | Assets, trust boundaries, attacker stories, controls, and severity calibration |
| [Self-pilot baseline](pilots/docgen-self.md) | Draft extraction-quality measurements awaiting maintainer approval |
| [Docgen v1 product contract](v1-product-contract.md) | Non-negotiable trust, determinism, ownership, privacy, and governance rules |

## The short version

docgen writes three kinds of statement and never blurs them:

- **`verified`** — a parser read the code, or a named developer answered. Fact.
- **`inferred`** — a model wrote it, with links to the lines it cites. Unchecked.
- **`unknown`** — nobody knows yet, so it is a question rather than a claim.

Only `docgen bootstrap` calls a model. Every other command is free.

See [SPEC.md](../SPEC.md) for the design rationale behind those choices.
