# For developers

You are not being asked to write documentation. You are being asked to answer questions about code you already know, one at a time, in your terminal.

## The deal

docgen reads your code and writes down what it can prove. For everything it cannot prove — is this route public, what happens when the payment provider times out, is that empty catch block deliberate — it asks you instead of guessing.

An answer takes about ten seconds and is usually a single digit. It is recorded permanently under your git identity, and you are never asked that question again.

## The daily loop

```bash
docgen ask --mine
```

Shows questions on code you last touched:

```
What happens when the payment provider times out?
  surface: checkout   id: retry-policy
  why asked: No timeout handling is visible in this surface.
  last touched by: you@example.com
    1. Retried automatically
    2. User must resubmit
    3. None of these — see comment
```

```bash
docgen answer checkout retry-policy 2
```

Done. That is now `verified` in the documentation, attributed to you, and injected into every future generation so the model cannot contradict it.

If none of the options fit, write it out:

```bash
docgen answer checkout retry-policy "It retries twice, then shows the saved-card picker again."
docgen answer checkout currency "GBP only" --note "EUR is planned for Q3."
```

Your coding agent will usually surface these for you after `docgen init` — you may never need to run `ask` by hand.

## Then say what it means

```bash
docgen triage
```

An answer says what happens. It does not say whether that is *intended*, and those lead to opposite places:

```
[1/4] checkout
What happens when the payment provider times out?
answered: User must resubmit

  [1] Intended behaviour  [2] Defect  [3] Technical decision  [4] Context only
  [s] skip  [q] quit
  > 
```

- **Intended behaviour** → becomes `REQ-checkout-01`, and a test case QA can work from.
- **Defect** → becomes `BUG-checkout-01`. You just filed a bug you already knew about.
- **Technical decision** → becomes `ADR-checkout-01`. The reason survives you leaving.
- **Context only** → recorded, but not something to test against.

Ctrl-C stops at any point; everything decided so far is kept.

## Linking a test

If a test checks a requirement, put the id in the test name or a comment. That is the whole mechanism:

```ts
it('REQ-checkout-01: the user must resubmit after a provider timeout', () => {
  // …
});
```

```python
# covers BUG-orders-02
def test_order_total_includes_tax():
    ...
```

```go
// REQ-billing-03
func TestInvoiceRounding(t *testing.T) { … }
```

`docgen trace` finds it there. Nothing else has to be maintained — no spreadsheet, no annotation format, no separate file to keep in sync.

## After changing code

```bash
docgen sync
```

Free, no model. Re-renders everything from your code and the committed cards, and deletes pages for things you removed. Commit the result with your change.

If you changed *what something does* rather than just its shape, re-infer that surface:

```bash
docgen bootstrap
```

Cached surfaces are free; only ones whose code actually changed are paid for.

## Things worth knowing

**Never hand-edit `docs/generated/` or `docs/.cards/`.** Both are regenerated and your edit will be lost. To correct something inferred, answer the question behind it — that overrides the model permanently, which an edit does not.

**`docs/.answers/` and `docs/.requirements/` are yours.** Plain YAML, meant to be readable, and safe to edit by hand if an answer was wrong. docgen never rewrites them except to add or replace an entry you gave it.

**Commit all of it.** The generated pages, the cards, the answers, and the requirements. The cards are what make the next run cheap; the answers are what make the documentation true.

**`bootstrap` costs money. Nothing else does.** `sync`, `check`, `ask`, `answer`, `triage`, `trace`, `status` and `extract` make no network call at all.

**A question you cannot answer is fine.** Skip it. It stays in the queue for whoever does know. Answering wrongly is worse than leaving it open, because a wrong `verified` answer is trusted.

## When the docs disagree with the code

That is `docgen check` failing, and it is working as intended:

```
error The committed documentation is out of date: 3 file(s) would change.
error   Run `docgen sync` and commit the result.
```

Run `docgen sync`, commit, done.

If a *behaviour* claim is wrong rather than a structural page, do not fix the page — answer the question behind it. The page is regenerated; the answer is not.

## Cheat sheet

```bash
docgen ask --mine                              # what is waiting on you
docgen answer <surface> <question-id> <n>      # ten seconds, permanent
docgen triage                                  # what those answers mean
docgen sync                                    # after any change — free
docgen status                                  # where this repo stands
```
