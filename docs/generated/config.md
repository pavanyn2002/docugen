---
generated: true
engine_version: 1.1.1
evidence_fingerprint: sha256:9e6307bc9372d9fe0745a647cd9c47f600d6296c27770233f5c965309943a794
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

| Workspace | Name | Read at | Declared in | Default |
| --- | --- | --- | --- | --- |
| `packages/docgen` | `COMSPEC` | [packages/docgen/src/agents/cli-backend.ts:141](../../packages/docgen/src/agents/cli-backend.ts#L141) | **not declared** | `'cmd.exe'` |

## Not determined (1)

> [!NOTE]
> These are things docgen could not establish from the code. They are **not** claims
> that something is missing or broken — they mark the limits of what static analysis
> could prove here.

| Kind | Detail | Source |
| --- | --- | --- |
| `env-read-never-declared` | 1 variable(s) are read but declared in no .env file: packages/docgen:COMSPEC. These may be supplied by the deployment environment, or they may be missing. | — |

