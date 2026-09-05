# Phase 8 — Dashboard and Reports

**Status:** IN PROGRESS · **Started:** 2026-09-05
**Result:** _(sections 10–12 stay empty until the phase is finished)_

> Sections 1–9 before any code. Sections 10–12 after.

---

## 1. What we are building

Three reports and the screens that show them. ADR-0014 merged these because the
reports **are** screens — splitting them meant building the UI shell twice.

1. **FREE-AI control coverage** — our actual controls mapped to the RBI
   committee's framework, with **evidence queried from the live database** and
   named gaps. `Control Coverage: n/20`, never a compliance percentage.
2. **STR draft** — suspicious activity detected from real decisions, drafted in
   FIU-IND-style fields, marked **DRAFT / HUMAN REVIEW REQUIRED**, never filed.
3. **DPDP processing register** — what personal data we hold, why, for how long,
   how it is minimised, and what is missing. **Privacy Control Coverage**, never
   "DPDP compliant".

Plus a dashboard: overview, transactions, agents, mandates, decisions, audit
trail with the integrity banner and the tamper button, risk signals, and the
three reports.

## 2. Why now

Six phases have produced evidence — decisions with per-rule breakdowns,
payments, a hash-chained trail, refused tool calls. Nobody can see any of it.

A compliance layer whose output is a `psql` session is not a product. The
reports are also the clearest statement of what the system is *for*: not
blocking payments, but **generating evidence that payments were governed**.

## 3. How it works

```
   PostgreSQL (six phases of real evidence)
        │
        ├── control coverage   20 controls × { query → evidence | gap }
        ├── STR candidates     decisions + rule_evaluations + risk_signals
        └── DPDP register      declared processing × live row counts
        │
   GET /v1/reports/free-ai | /str | /dpdp        ← admin key
        │
   Next.js dashboard (apps/dashboard)             ← ADR-0002: separate deployable
```

**Every number on every screen is a query.** No report contains a figure that
was typed in by hand, because a hand-typed figure is a claim, and this product
exists to replace claims with evidence.

## 4. Concepts I need first

**A framework is not a certification.** RBI's FREE-AI is a **committee report**
— seven sutras, six pillars, 26 recommendations, published 13 Aug 2025. There is
no certifying authority, no audit scheme, and no scoring methodology. So
"98.75% compliant" (which the research asserts) is not merely wrong, it is
*unmeasurable*. What can be measured is: for each control we chose to
implement, is there evidence in the database, and what is missing?

**Control coverage, not a score.** `18/20` with the two gaps named is a
defensible engineering statement. A percentage implies a denominator somebody
else agreed to.

**An STR is a legal filing, and we cannot make one.** Filing runs through
FIU-IND's FINnet by *registered reporting entities*. We are not one. The honest
workflow stops at "ready for filing" and hands a human a draft.

**Data minimisation is architectural, not procedural.** The strongest privacy
control in this system is that `users` has **nowhere to put** a full phone
number: `phone_last4` is `CHECK (~ '^[0-9]{4}$')`. Data never collected cannot
leak. Everything else — encryption, access control, redaction — reduces risk
without eliminating it.

**Information hierarchy.** A compliance dashboard's job is to make the
*exception* findable. Most decisions pass; nobody needs to see them. The screens
lead with what broke, what is flagged, and what is unproven.

## 5. Design choices & tradeoffs

**1 — Every control's evidence is a live query, and a control with no evidence
is a GAP, not a pass.**
The default is failure. A control whose query returns nothing reports
`no_evidence` and is excluded from the numerator. It is the same fail-closed
instinct as the voucher and the checkpoint secret: silence must never read as
success.

**2 — Controls are declared with their own verification query.**
Each control names what would prove it. That keeps the report honest under
change: if a Phase 9 refactor removes a control, its query stops returning rows
and the coverage number drops by itself. **Nobody has to remember to update the
report.**

**3 — The STR detector is deterministic, and it is not fraud detection.**
It selects decisions that BLOCKED on specific rules, or that carry a HIGH risk
band, or that show a burst pattern. Explainable and reproducible. ADR-0010's
line holds: this is "was this suspicious *by a stated rule*", not a model.

**4 — Drafts are stored, versioned and audited.**
A draft is evidence about our own process — who generated it, when, on what
data. Generating one writes an audit event. Migration 0010 adds the table.

**5 — The DPDP register is declared in code, counted from the database.**
The *declaration* (purpose, legal basis, retention) is a human judgement and
lives in a reviewed source file. The *counts* are queries. Mixing them would let
a stale declaration hide behind a live number.

**6 — The dashboard is a separate Next.js app (ADR-0002).**
It calls the API over HTTP. It holds no database credentials and re-implements
no policy logic — it renders what the API says. The one thing it must never do
is compute a compliance figure of its own.

**7 — Simulated components are labelled in the UI, not only in the docs.**
Every payment row shows its provider; `mock_upi` renders as a visible
SIMULATED badge. A screenshot must be unable to misrepresent the system.

### Where the LLM is, in this phase

Optionally, in exactly one place: **drafting prose about findings already
computed**. The candidate set, the amounts and the rule citations are produced
by SQL. A model may summarise them into a narrative paragraph. It may not select
candidates, and the draft records which fields were model-written.

## 6. Files created/modified

```
apps/api/src/
  reports/controls.ts        20 FREE-AI controls, each with its own query
  reports/free-ai.ts         coverage computation
  reports/str.ts             deterministic candidate detection + draft
  reports/dpdp.ts            declared processing register + live counts
  reports/*.test.ts
  routes/reports.ts          GET /v1/reports/{free-ai,str,dpdp}, POST /str/draft
  db/migrations/0010_reports.sql
apps/dashboard/              Next.js app (ADR-0002)
```

## 7. How we test it

| Claim | The test that would fail |
|---|---|
| Coverage counts only controls with real evidence | drop the evidence, expect the count to fall |
| A control with no evidence is a GAP | assert `no_evidence` is excluded from the numerator |
| No report emits a compliance percentage | scan every response for `%` and "compliant" |
| Evidence comes from the database | change a row, expect the number to change |
| STR candidates are deterministic | run twice, expect identical output |
| An STR draft is never "filed" | assert status is DRAFT and the word "filed" never stands alone |
| A draft is audited | assert an audit event exists |
| The DPDP register names its gaps | assert the gap list is non-empty and specific |
| Simulated payments are labelled | assert every mock payment carries the flag |

## 8. Security notes

| Threat | Control |
|---|---|
| Report endpoints leak personal data | admin key; the register itself shows only masked fields |
| A report is used as a compliance claim | the honesty caveat is a required field in every response |
| Coverage inflated by a stale hand-typed number | every figure is a query |
| An STR draft is mistaken for a filing | status is `DRAFT`, and the response carries the FIU-IND caveat |
| Dashboard XSS from merchant text | React escapes by default; no `dangerouslySetInnerHTML` |
| Dashboard holds credentials | it holds none; it calls the API |

## 9. What happens at scale

Coverage queries are aggregates over the whole evidence set. At MVP volume that
is milliseconds; at production volume they become a nightly materialised
snapshot, which is what a monthly compliance report actually wants anyway —
a figure that does not change while you are reading it.

STR detection is a range scan over `decisions` and `rule_evaluations`, both
already indexed on `(rule_code, verdict, created_at)` and
`evaluated_at WHERE verdict IN ('BLOCK','FLAG')` — the partial index built in
Phase 2 for exactly this report.

---

## 10. What I learned

_(after the phase)_

## 11. Mistakes made & why

_(after the phase)_

## 12. Open questions / debt

_(after the phase)_
