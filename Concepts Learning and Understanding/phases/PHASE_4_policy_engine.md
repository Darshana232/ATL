# Phase 4 — The Policy Engine

**Status:** ⬜ next · everything below is *planned*, not built

---

## What it is

The heart of the product: a **pure function** that takes a mandate, a payment
request, the spend so far, the current time and a risk signal, and returns a
typed `Decision` — a verdict plus a reason per rule.

```
(mandate, request, spentInWindow, now, risk) → Decision
```

No database. No network. No clock of its own. No language model. Same inputs →
same output, forever.

## Why it comes here

It needs a mandate to evaluate against (Phase 3). Everything after it needs a
decision to act on.

## The seven rules

| Rule | Question | Verdict on failure |
|---|---|---|
| `MANDATE_PER_TXN_LIMIT` | Is this amount within the per-transaction cap? | BLOCK |
| `MANDATE_WINDOW_LIMIT` | Does spend-so-far + this amount stay inside the day/week/month cap? | BLOCK |
| `MERCHANT_ALLOWLIST` | Is this merchant explicitly allowed? | BLOCK |
| `CATEGORY_BLOCKLIST` | Is the merchant's MCC in the blocked set? | BLOCK |
| `VELOCITY` | Are there more than N transactions in the last hour? | BLOCK |
| `TIME_WINDOW` | Is the local time inside the permitted hours and weekdays? | BLOCK |
| `MANDATE_VALIDITY` | Is the mandate active, not revoked, not expired, already started? | BLOCK |

Plus the **advisory** risk input, which can turn a `PASS` into a `FLAG` — and
can never do anything else. (See
[D2](../03_PRODUCT_DECISIONS.md).)

## The shape of an explanation

```
Signal → Rule → Evaluation → Verdict → Reason
```

This is a **typed record emitted by code**, one row per rule per decision, not
prose from a model. A reason looks like:

> "Requested ₹6,200 exceeds the ₹2,000 per-transaction limit by ₹4,200."

Numbers, computed by the rule that failed. That is the whole difference between
an explanation and an apology.

## The steps

1. `Verdict`, `RuleResult`, `Decision` types — make illegal states
   unrepresentable.
2. Each rule as its own pure function with its own tests.
3. The evaluator that runs all seven and combines them (**every** rule runs, so
   a blocked request tells you *all* the reasons, not just the first).
4. The risk provider interface + `MockRiskProvider`, labelled SIMULATED.
5. Persistence: write `decisions` + one `rule_evaluations` row per rule.
6. A property test: the same inputs always produce the same output.

## What you can do after it

Feed it a mandate and a request in a unit test — no server, no database — and
get a verdict with reasons. Then re-run last month's decision and get the
identical result.

## Concepts it teaches

- [Pure functions and determinism](../concepts/backend/14_pure-functions-and-determinism.md)
- [Determinism vs probabilism](../concepts/llm-agents/09_determinism-vs-probabilism.md)
- [Types that prevent bugs](../concepts/engineering/01_typescript-types-that-prevent-bugs.md)
- [MCC codes](../concepts/domain/03_mcc-merchant-category-codes.md)

## The honest gap

Seven rules is not a compliance framework; it's a defensible starting set. The
argument is that rules are *modular* — adding an eighth is a file and a test,
not a retrain.
