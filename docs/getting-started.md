# Getting started

About five minutes, on any repository.

## 1. Check you can run it

```bash
npx @tatvaops/docgen --version
```

Needs Node 20.11 or newer. Nothing else is installed and nothing is written yet.

## 2. Look at the structure — free

```bash
npx @tatvaops/docgen extract
```

This reads your code and writes `docs/generated/`. It makes no network call, calls no model, and costs nothing. Everything it writes is `verified`: every row links to the file and line it came from, so any statement is one click from the code that proves it.

Open `docs/generated/README.md`. It lists what was found, and — just as importantly — what docgen could not read:

```
Detected stack
  3 workspaces
   ok SQL migrations in supabase/migrations/
  gap FastAPI in backend/
   ok Next.js in frontend/
warn  docgen cannot document 1 detected technology. The output below is
warn  incomplete — an empty section does not mean the repo has nothing there.
```

That warning matters more than the coverage itself. An unsupported stack and a genuinely empty repo both produce an empty section, and no reader can tell them apart unless it is stated.

If nothing was found at all, see [Troubleshooting](troubleshooting.md#extract-found-nothing).

## 3. See what would be inferred — still free

```bash
npx @tatvaops/docgen bootstrap --dry-run
```

This reports how many surfaces exist and which model backends are available:

```
Surfaces
  found     36
  cached    0

Available backends
   ok Claude Code
   ok Codex CLI
    -  Anthropic API
       Install @anthropic-ai/sdk and set ANTHROPIC_API_KEY.

Dry run
  no model was called and nothing was written
```

A **surface** is the unit a QA person asks about: one screen, one endpoint group, one background job. Not one file.

If no backend is available, see [Troubleshooting](troubleshooting.md#no-llm-backend-is-available).

## 4. Describe behaviour — this one costs money

Start bounded, so you can see the output before paying for all of it:

```bash
npx @tatvaops/docgen bootstrap --limit 3
```

This drives a coding CLI you have already signed in to. For each surface it produces a **feature card**: what the surface does, what a user can observe, what states it can be in, edge cases actually present in the code — and every question it could not answer.

Every claim carries links to the lines it cites. A claim with no citation is rejected rather than published. A surface it could not describe is reported, not quietly left out.

Open `docs/generated/behaviour.md`, then one of the pages under `behaviour/`. Everything is badged `inferred`. None of it has been checked by anyone yet.

## 5. Answer the questions — this is the point

```bash
npx @tatvaops/docgen ask --mine
```

```
Is `/` intended to be reachable without authentication?
  surface: screen   id: auth-requirement
  why asked: Static analysis found no guard on the route, and app/page.tsx
             contains no auth check. Absence of a guard in this file does not
             establish whether auth is enforced elsewhere.
  last touched by: you@example.com
    1. Yes — it is a public landing page by design
    2. No — auth is enforced by middleware not shown here
    3. Auth is not implemented yet anywhere in the app
    4. None of these — see comment
```

Answer it with a number:

```bash
npx @tatvaops/docgen answer screen auth-requirement 1
```

That answer is now ground truth. It is recorded in `docs/.answers/` under your git identity, shown as `verified` in the documentation immediately, injected into every future generation so the model cannot contradict it, and the question is never asked again.

## 6. Say what the answer means

An answer says what *happens*. It does not say whether that is *intended* — and those lead to opposite outcomes:

```bash
npx @tatvaops/docgen triage
```

One keystroke per answer: intended behaviour, a defect, a technical decision, or context. This produces `docs/generated/requirements.md`, the only page that can be read as a specification.

## 7. Keep it current

```bash
npx @tatvaops/docgen sync    # after any code change — free
npx @tatvaops/docgen check   # CI gate: fails if the docs are stale — free
```

`sync` re-renders everything from the current code and the committed cards. It does **not** re-infer, so it costs nothing. Only `bootstrap` calls a model, and only for surfaces whose code actually changed.

## 8. Make it stick

```bash
npx @tatvaops/docgen init
```

This writes a block into `AGENTS.md` (and `CLAUDE.md` / a Cursor rule where the repo already uses those) telling whatever coding agent is open in the repo to surface pending questions when work finishes. Where the repo uses GitHub Actions, it also adds the drift gate.

Only the block between the docgen markers is managed. Anything you write outside those markers is preserved.

## Where to go next

- [The trust model](trust-model.md) — what `verified`, `inferred`, and `unknown` each guarantee
- [For developers](for-developers.md) — the daily loop
- [Rolling out across repos](rollout.md) — doing this to forty repositories without it being ignored
