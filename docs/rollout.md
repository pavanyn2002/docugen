# Rolling out across repositories

The hard part is not any single repository. It is getting forty of them documented without the effort being abandoned in week three.

## What makes this fail

Rollouts of this kind fail in predictable ways, and the defaults are chosen against each:

| Failure | What prevents it |
|---|---|
| "It costs too much" | Only `bootstrap` calls a model. The gate, the sync, and the whole reporting side are free. |
| "CI is red everywhere" | `check` is not strict by default. It fails on stale files, not on unanswered questions. |
| "Nobody answers the questions" | `docgen init` puts them in the agent already open in the repo, at the moment work finishes. |
| "The tool overwrote our stuff" | Adapters write a delimited block and preserve everything outside it. |
| "Every repo is on a different version" | The CI gate pins a version; Dependabot moves it weekly. |
| "It became a leaderboard" | `fleet` reports gap sizes and next actions. There is deliberately no score. |

## A sequence that works

### 1. Pick one repository you know well

Somewhere you can judge whether the inferred output is any good.

```bash
cd ../some-repo
npx @tatvaops/docgen extract       # free
npx @tatvaops/docgen bootstrap --limit 3
```

Read the three behaviour pages. Check a few of the evidence links. Answer a couple of questions and watch them turn `verified`.

This is the step that tells you whether to continue. Do not skip it.

### 2. Roll `extract` out everywhere

Free, safe, and immediately useful on its own — structural documentation of forty repositories, with every line traceable to code.

```bash
for repo in ../*/; do
  (cd "$repo" && npx @tatvaops/docgen extract && npx @tatvaops/docgen init)
done
```

`init` installs the agent adapters and the CI gate. At this point the fleet has real documentation and a gate keeping it current, and nothing has cost anything.

### 3. Get a baseline

```bash
npx @tatvaops/docgen fleet ../*/ --out fleet.md
```

```
- **0 of 612 surfaces** have been described at all.
- **0 questions** are waiting on a developer.

| Repository | Surfaces | Described | Open questions | Untriaged | Requirements | Tested | Drift |
| --- | --- | --- | --- | --- | --- | --- | --- |
| billing-service | 41 | 0 | 0 | 0 | 0 | 0/0 | — |
| checkout-web | 63 | 0 | 0 | 0 | 0 | 0/0 | — |
```

Now you know where the work is, and which repositories are worth an afternoon.

### 4. Bootstrap the ones that matter

Not all of them, and not at once. Pick by traffic, by risk, or by which team is loudest about QA friction.

```bash
cd ../checkout-web
npx @tatvaops/docgen bootstrap
```

Surfaces are processed one at a time, so it is slow but predictable, and every card is cached — a second run costs nothing for unchanged surfaces.

### 5. Let the questions find people

After `docgen init`, a developer's coding agent raises pending questions when they finish work on a file. They answer one; it becomes permanent.

For a push rather than a pull, `docgen ask --json` carries the likely owner per question — enough to open tickets, post a digest, or fan out however your team already works.

### 6. Triage in batches

Answers accumulate faster than they get classified. A weekly pass takes minutes:

```bash
npx @tatvaops/docgen triage
```

That is what produces `requirements.md`, which is what QA can actually use.

### 7. Tighten the gate, repo by repo

Once a repository's queue is drained:

```bash
npx @tatvaops/docgen check --strict
```

Do this per repository as it earns it, never fleet-wide at the start.

## Version management

Pin deliberately. An engine upgrade can change generated output, and that should be a reviewed commit rather than a surprise.

```bash
npm install --save-dev @tatvaops/docgen@0.1.0
```

`docgen init` picks this up: it writes `npx docgen` into the workflow and the agent instructions, so the repo's own pinned version is what runs everywhere. Where docgen is not a repo dependency, the workflow fetches a pinned version instead, and Dependabot is not added — there is nothing for it to bump.

When a new version lands, review one repository's diff before merging the rest. If the output changed, that is the engine improving, and you want to see how.

## What to tell developers

One paragraph is enough:

> We are documenting our repos with a tool that reads the code. It will not ask you to write anything. Occasionally it will ask you a question about code you touched — usually multiple choice, ten seconds — and your answer becomes permanent so it never gets asked again. Your coding agent will surface them. Everything the tool infers on its own is marked unverified until someone answers.

The full version is [For developers](for-developers.md).

## What to tell QA

> Only the parts marked `verified` are a specification. Everything marked `inferred` was written by a model reading the code and has not been checked — do not file bugs against it, ask for it to be confirmed instead. `requirements.md` is the page that counts.

The full version is [For QA](for-qa.md).

## Keeping an eye on it

```bash
npx @tatvaops/docgen fleet ../*/ --out fleet.md
```

Free, so a nightly job is fine. Watch two numbers over time: **described / surfaces** (is coverage growing) and **untriaged** (are answers turning into requirements, or piling up).

Rising `untriaged` means people are answering but nobody is classifying — the fix is a scheduled triage pass, not more prompting.

## Honest expectations

- `extract` across a fleet: minutes, free, and useful immediately.
- `bootstrap` on a large repo: tens of minutes, and it costs money. Bound it with `--limit` the first time.
- Questions get answered when they arrive where developers already are. They do not get answered from a dashboard.
- The first `requirements.md` will be short. That is accurate — it reflects what has actually been confirmed, which is the entire point.
