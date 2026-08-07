# For QA

How to read what docgen produces, and — more importantly — how to tell which parts you can hold a developer to.

## The one rule

**Check the badge.** Every behavioural statement carries one, on the line itself.

| Badge | Means | Can you file a bug against it |
|---|---|---|
| `verified` | A named developer confirmed this, on a date | **Yes.** This is the spec. |
| `inferred` | A model read the code and wrote this. Nobody checked it. | **No.** Ask for it to be confirmed first. |
| `unknown` | Nobody has established this yet | **No** — but this is exactly what to ask about. |

A page with no badges at all — `routes.md`, `api.md`, `schema.md`, `jobs.md`, `config.md` — is entirely verified by a parser reading the code. Those are facts.

## Where to start

`docs/generated/README.md` is the index. Read the top of it first: it says what docgen could *not* read.

> **This documentation is incomplete.** docgen detected technology it cannot read:
> - **FastAPI** (`backend/requirements.txt`) — Python routes are not extracted.
>
> An empty section below does not mean the repository has nothing there.

This matters. An empty section and an unsupported stack look identical. Never read "no endpoints listed" as "there are no endpoints" unless the page says the extractor ran and found none.

## The pages, in the order you'll want them

**`requirements.md`** — the only page that is a specification. Every entry was answered by a named developer and then classified by one. Nothing here came from a model.

```
### REQ-checkout-01

What happens when the payment provider times out?

**The user must resubmit.**

checkout · dev@example.com, 2026-02-01
```

That is something you can test against and file a bug against. It also states its own coverage — if answers are still untriaged, it says how many and warns that whatever they establish is missing.

Entries are grouped by kind:
- **Intended behaviour** — the spec.
- **Defect** — a developer has confirmed the code does the wrong thing. Already a known bug.
- **Technical decision** — why something is built the way it is.
- **Context only** — useful background, not a requirement.

**`test-cases.md`** — one case per confirmed requirement or defect, each linked to its requirement id.

Steps are deliberately blank. docgen was never told how to reach these states, and invented steps would send you down a path that does not exist. Fill them in as you write the tests.

**`traceability.md`** — what is actually checked, and what is not. Three gaps:

| Gap | What it means for you |
|---|---|
| Requirement with no test | Agreed behaviour nothing verifies. Prime candidate for your next test. |
| Test citing an unknown requirement | A broken link. Usually a typo or a deleted requirement — raise it. |
| Behaviour mapping to neither | A surface nobody has confirmed anything about. Nothing to test against. **Start here.** |

**`behaviour/<surface>.md`** — what a screen or endpoint group appears to do. Mostly `inferred`.

Every claim links to the exact lines it came from. Use it to orient yourself quickly, but do not treat it as a spec. The page says so at the top, and repeats the count of unanswered questions.

**`routes.md`, `api.md`, `schema.md`, `jobs.md`, `config.md`** — structural facts. Every row links to `file:line`. Use these for coverage planning: which screens exist, which endpoints, what shape the data is.

Look for the **Not determined** section on each. That is what static analysis could not establish — not a list of defects, but the limits of what was proven.

## Turning an `unknown` into something you can test

This is the highest-value thing you can do with this tool.

Open a behaviour page and look at **Open questions**. Each one shows the exact command that closes it:

```
### `unknown` Is /checkout reachable without authentication?

Static analysis found no guard on the route, and no auth check appears in the
provided files — but absence of a guard in these files does not establish the
intended access rule.

  1. Fully public
  2. Public, but authenticated users should be redirected
  3. Guarded elsewhere (middleware, layout)

docgen answer checkout auth-requirement <number>
```

Take that to the developer who last touched the file — `docgen ask` shows who that is. One answer, ten seconds, and it becomes `verified` and testable. If they say the answer is "a bug", it becomes a filed defect with an id.

You do not need to run docgen yourself. You need to know which question to ask, and this tells you.

## Reading a guard honestly

When docgen says:

> no guard detected (this does **not** mean it is public)

it means exactly that. Static analysis found no auth check in the files it read. Auth could be enforced in middleware, a parent layout, a proxy, or an edge config it never saw. Never test "this endpoint is public" against that line — ask for it to be confirmed, and then it becomes a requirement you *can* test.

## Useful commands

You can run these read-only:

```bash
docgen status              # where this repo stands, in one screen
docgen ask                 # every open question, with who to ask
docgen ask --json          # for a script or a ticket import
docgen trace               # what is covered, and the three gaps
```

None of them write anything or cost anything.

## What to push back on

- A behaviour claim being cited in a ticket while still badged `inferred`. Ask for it to be answered first — it takes the developer ten seconds and makes it permanent.
- An empty section on a page whose stack docgen cannot read. That is unknown coverage, not absence.
- A surface under "Behaviour mapping to neither". Nobody has agreed what it should do and nothing checks it. That is where undetectable bugs live.
