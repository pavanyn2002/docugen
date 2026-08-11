# Docgen repository threat model

## Overview

Docgen is a local Node.js CLI and MCP stdio server that reads a software
repository, builds an evidence graph, generates governed documentation, and can
install agent, Git-hook, and CI integrations. Its primary security objective is
the integrity and provenance of documentation that developers, reviewers, and
testers may treat as organizational truth. Secondary objectives are preserving
repository contents, keeping source and credentials private, and making every
unsupported or unverified result visible.

The shipped runtime is `packages/docgen/src/`. Tests, fixtures, and this
documentation are development surfaces, except where `docgen init` deliberately
copies generated instructions or CI configuration into a target repository.
Docgen is not a network service and provides no authentication boundary of its
own. Network access occurs only when an explicitly configured API inference
backend is used, when a locally installed coding CLI chooses to use a remote
provider, or when package installation in a generated CI workflow contacts a
registry.

Important assets are:

- source code and configuration read from the target repository;
- credentials present in files or inherited process environment variables;
- evidence-graph provenance, developer answers, requirements, plans, change
  records, policy exceptions, and tester handoffs;
- target repository files, Git configuration, hooks, and CI workflows that
  Docgen may update;
- API budgets and the identity of the configured inference provider/model;
- the trust that developers and testers place in generated output.

## Threat Model, Trust Boundaries, and Assumptions

### Actors and controlled inputs

- A repository contributor can control source files, manifests, existing docs,
  configuration, Git history, and content subsequently included in a model
  prompt. A contributor with write access can already change application code;
  Docgen must not silently amplify that access into unrelated files or falsely
  label contributor-controlled prose as parser-verified fact.
- The operator controls the working directory, CLI arguments, environment,
  PATH, provider/model allowlists, local-only mode, and whether write-capable
  commands such as `init`, `sync`, `legacy archive`, or `handoff` run.
- An MCP host controls JSON-RPC requests sent over the process's stdin. The host
  has the same repository permissions as the Docgen process.
- Package publishers and registries control dependency archives and install
  scripts. A compromised dependency executes with CI or developer privileges
  when npm installs it; the offline security scan itself never installs code.
- Model providers and local coding-agent CLIs receive prompts and return
  attacker-influenceable text. Model output is untrusted even when its JSON is
  well formed.
- QA and future maintainers consume generated pages and may not inspect the
  implementation. Provenance labels and deterministic gates are therefore
  security controls, not presentation details.

### Trust boundaries

1. **Repository content to static analyzers.** Parsers consume untrusted text and
   must not execute it. The static extraction lane is import-separated from
   inference code and marks only parser evidence or recorded human answers as
   verified (`docs/trust-model.md`, `tests/boundaries.test.ts`).
2. **Repository content to an inference provider.** Source excerpts cross a
   privacy boundary during `bootstrap`. Secret redaction, local-only mode, and
   provider/model allowlists reduce exposure (`src/privacy/redact.ts`,
   `src/commands/bootstrap.ts`), but pattern redaction cannot guarantee that all
   proprietary or novel credential formats are removed.
3. **Model response to governed documentation.** Strict schemas, evidence
   citations, bounded output, timeouts, and explicit `inferred`/`unknown` lanes
   limit model authority (`src/infer/`, `src/agents/`). A cited inference is not
   a verified requirement.
4. **CLI or MCP request to repository writes.** Commands resolve target paths,
   use managed blocks or Docgen-owned files, validate stored schemas, and use
   atomic replacement for critical records. Legacy archive additionally rejects
   symlink sources and supports rollback (`src/commands/legacy.ts`). MCP is local
   stdio; it has one declared write-capable handoff tool and validates argument
   types (`src/mcp/server.ts`).
5. **Docgen to local executables and Git.** Git and coding CLIs are launched with
   argument arrays. Coding-CLI shim arguments are restricted, prompts travel on
   stdin, output is capped, and invocations time out
   (`src/agents/cli-backend.ts`). The resolved PATH executable and Git binary are
   assumed to be trusted by the operator.
6. **Generated integration to CI and package registries.** `init` can install a
   workflow, Dependabot config, MCP files, and an opt-in pre-push hook. Managed
   ownership checks prevent overwriting team-owned hooks/configuration
   (`src/adapters/`). Package installation still inherits npm registry and
   package-publisher risk.
7. **Stored governance data to CI decisions.** Feature, plan, change, answer, and
   exception files are repository-controlled inputs. Schemas, immutable IDs,
   time-bounded exceptions, Git comparisons, and `docgen check` preserve
   consistency, but Git identity and timestamps are only as trustworthy as the
   repository's commit-signing and access-control policy.

### Security invariants and assumptions

- Parser-derived output must never depend on a model or be labelled verified
  without file/line or attributed-human provenance.
- Missing, malformed, unsupported, or contradictory evidence must remain a gap
  or fail loudly; it must never become plausible generated prose.
- An inference run must disclose the provider, model, files, prompt size, and
  redaction count before transmitting content.
- `privacy.localOnly` and provider/model allowlists must prevent the prohibited
  backend from being selected, including automatic selection.
- Write commands must remain inside their documented target scope and must not
  silently overwrite team-owned hooks, MCP tables, or legacy documents.
- CI enforcement must be deterministic, offline, and reproducible from the Git
  base and committed governance artifacts.
- Supply-chain output must distinguish inventory/provenance checks from current
  vulnerability intelligence. An offline clean report is not a CVE clearance.
- The operating system account, repository access controls, PATH, installed
  agent CLIs, Git executable, and CI secret configuration are trusted. Docgen is
  not a sandbox for hostile repositories or hostile local executables.

## Attack Surface, Mitigations, and Attacker Stories

### Source parsing and resource use

A malicious or accidentally huge repository can provide pathological syntax,
deep graphs, many files, malformed JSON/YAML, or cyclic imports to consume CPU
and memory. Extractors use syntax parsers rather than evaluating project code,
apply configured exclusions, report unresolved evidence, and use iterative
graph algorithms where depth could overflow the stack. Remaining risk includes
resource exhaustion from repository scale or parser defects. Running Docgen on
an entirely hostile checkout should occur in a disposable environment.

### Prompt injection and data disclosure

Source comments can contain instructions aimed at the model. Such instructions
can influence inferred cards but cannot legitimately create parser-verified
facts or developer answers. Strict output schemas, evidence requirements, and
visible provenance limit impact. The more serious story is unintended source or
secret disclosure: source excerpts are intentionally sent during inference and
redaction is heuristic. Local-only mode is the control for repositories that
must not cross a provider boundary. Operators should also exclude sensitive
paths and restrict API keys and provider retention according to their own
policy.

### Subprocess and configuration abuse

A malicious model name or configuration value could target shell injection,
especially through Windows command shims. Docgen uses `execFile`, validates shim
arguments, sends prompts on stdin, disables interactive pagers/editors, caps
output, and applies timeouts. A PATH-precedence attack remains possible if an
attacker can install or replace `git`, `claude`, `codex`, or `cursor`; that
attacker already has local execution capability and is outside Docgen's process
boundary. Configuration remains untrusted input and is schema-validated before
use.

### Filesystem, legacy migration, and integration writes

Path traversal or symlink confusion could overwrite files outside the intended
repository, while a partial write could corrupt governance history. Output-path
boundary checks, symlink rejection for legacy archive, schema validation,
temporary files plus rename, duplicate-ID rejection, and rollback reduce these
risks. Some explicitly operator-supplied report destinations may be outside the
repository by design; filesystem permission to those destinations is the
operator's authorization. `init` preserves non-managed content and refuses to
take over a team-owned Git hook or Codex MCP table.

### MCP and agent automation

The MCP server has no network listener and processes requests sequentially over
stdio. Its host can read graph and governance information and can request a
tester-handoff write using the Docgen process's filesystem permissions. Tool
annotations communicate write intent but are not authorization. Operators must
trust the MCP host and should not expose stdio through an unauthenticated remote
bridge. Input schemas and bounded graph traversal reduce malformed-request and
resource risks.

### Documentation and governance poisoning

A contributor may edit stored answers, requirements, plans, exceptions, or
generated pages to mislead QA. Generated-page drift is detected by `check`;
stored records are strictly parsed; change and plan IDs are immutable; policy
exceptions require an owner, reason, and future expiry; and test citations are
checked. These controls provide consistency, not independent truth. Protected
branches, review, signed commits where warranted, and CODEOWNERS-like controls
remain necessary for high-assurance teams. Git email attribution alone is not
strong identity proof.

### Dependency and CI compromise

Package archives and install scripts execute outside Docgen's static-analysis
trust boundary. `docgen security scan` checks lock presence, exact Python pins,
integrity metadata, insecure archive transport, non-registry direct sources,
and npm install scripts. `docgen security sbom` creates a deterministic
CycloneDX inventory. Unsupported ecosystems are explicit gaps. Neither command
downloads advisories or proves that a version is safe; CI must run a current
ecosystem advisory scanner and verify package provenance. Generated workflows
pin the Docgen package version when configured, but registries, actions, and the
runner remain external supply-chain dependencies.

Conventional web risks such as CSRF, browser XSS, cookie theft, SQL injection,
tenant isolation, and public rate limiting are not directly applicable because
Docgen exposes no HTTP application or database. They become relevant only in a
separate system that remotely wraps the CLI/MCP server or publishes its output,
and belong in that system's threat model.

## Severity Calibration (Critical, High, Medium, Low)

### Critical

- A default Docgen operation enables arbitrary code execution from repository
  content without the operator explicitly choosing an inference CLI or package
  installation.
- A remotely reachable wrapper permits an unauthenticated attacker to invoke a
  write operation or read arbitrary repository/source content across tenants.
- Generated verified documentation can be forged without parser or attributed
  human provenance and passes the deterministic CI gate at scale.

### High

- A crafted repository path or symlink causes a normal write command to
  overwrite sensitive files outside its authorized target.
- `localOnly` or a provider/model allowlist is bypassed and private source is
  transmitted to a prohibited external provider.
- Dependency resolution uses mutable, unauthenticated, or unpinned inputs in CI
  such that a publisher or network attacker can reliably execute code.
- A governance-policy or expiry bypass allows critical feature changes to pass
  CI without the required plan, handoff, verification, or tests.

### Medium

- Prompt injection produces misleading inferred documentation with valid-looking
  citations, while provenance remains visibly `inferred` and no verified record
  is changed.
- An npm dependency with an install script or an explicitly chosen Git source
  increases install-time execution risk but still requires the operator/CI to
  install dependencies.
- Malformed or adversarial repository content causes repeatable resource
  exhaustion or corrupts a regenerable local cache without code execution or
  cross-repository writes.
- Git email attribution can be spoofed in a workflow that does not require
  signed commits, weakening accountability but not bypassing repository review.

### Low

- Error messages reveal repository-relative paths or dependency names to a user
  who already has local repository access.
- A deterministic report omits a supported-but-unimportant metadata field while
  clearly recording an extraction gap and not changing governance decisions.
- Availability or formatting defects affect generated dashboards or inferred
  prose but are caught by drift checking and do not alter verified records.

Severity drops when exploitation requires pre-existing local code execution,
write access equivalent to the effect, or an explicitly trusted operator to
choose a dangerous external tool. It rises when the same weakness crosses
repository boundaries, silently changes verified truth, exposes protected
source, or executes in CI with secrets and release privileges.
