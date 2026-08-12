---
generated: true
engine_version: 1.0.1
evidence_fingerprint: sha256:a6a0fadeb6cc6d026701579906eb273c4d014a7773d980e9263b30c65bf3dc13
confidence: verified
---

<!-- docgen:generated -->

<!-- Do not edit by hand. Regenerate with `docgen extract`; changes here will be lost. -->

# Environment and configuration

Read from `code`. Every row links to the code it came from.

> [!NOTE]
> Only names and locations are recorded. docgen never reads a value from a `.env` file,
> because this page is committed and those files hold credentials.

## Read and declared (0)

_None._

## Read but never declared (1)

These are read by the code but appear in no `.env` file. They may be supplied by the deployment environment, or they may be missing — docgen cannot tell which.

| Name | Read at | Declared in | Default |
| --- | --- | --- | --- |
| `COMSPEC` | [packages/docgen/src/agents/cli-backend.ts:141](../../packages/docgen/src/agents/cli-backend.ts#L141) | **not declared** | `'cmd.exe'` |

## Not determined (1)

> [!NOTE]
> These are things docgen could not establish from the code. They are **not** claims
> that something is missing or broken — they mark the limits of what static analysis
> could prove here.

| Kind | Detail | Source |
| --- | --- | --- |
| `env-read-never-declared` | 1 variable(s) are read but declared in no .env file: COMSPEC. These may be supplied by the deployment environment, or they may be missing. | — |

