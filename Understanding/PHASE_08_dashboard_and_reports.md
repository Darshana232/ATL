# Phase 8 — Dashboard and Reports

**Status:** DONE · **Started:** 2026-09-05 · **Finished:** 2026-09-05
**Result:** three reports, eleven dashboard screens, 632 tests. Coverage came
back 20/26 — after the first version returned a meaningless 20/20.

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

**A perfect score is a design smell.** My first control set returned **20/20
with zero gaps**, and I nearly shipped it. The number was worthless — not
because it was wrong, but because it was *guaranteed before a single query ran*.
I had listed only the controls I had already built. That is the same species of
claim as "98.75% compliant", just with better manners: a measurement over a
self-selected set of successes.

The fix was to put the **missing** controls in scope. Coverage is now 20/26, and
six named gaps sit above the covered ones on the screen — including "NO MERCHANT
INTERVIEWS HAVE TAKEN PLACE". A number that *can* move is the only kind worth
printing.

**A ratio and a percentage are different rhetorical objects.** "20/26" invites
"which six?" — exactly the question a compliance officer should ask. "77%"
invites nothing, and implies a denominator somebody else agreed to. There is no
such denominator here.

**Controls should carry their own verification query.** This turned out to be
the single best structural decision in the phase. If a Phase 9 refactor removes
a control, its query stops returning rows and coverage drops **by itself**.
Nobody has to remember to update the report — and "remember to update the
report" is a control that fails silently and immediately.

**A failing query is not an empty one.** A control whose evidence query *errors*
is more alarming than one returning zero: it means the thing we thought we were
measuring no longer exists in the shape we assumed. It reports `error`, and it
is not counted.

**Empty states are a correctness problem, not a polish problem.** On this
console, an empty audit view could mean "nothing happened" or "the API is
unreachable" — opposite situations demanding opposite responses. So every empty
state says *why* it is empty and what to do.

**Where the caveat lives determines whether it exists.** A caveat in the README
gets separated from the number the first time somebody screenshots a screen. So
the honesty text is a **required field in every report response** and is rendered
unsuppressed on the page, and the standing disclaimer lives in the sidebar —
visible in every screenshot of every screen.

**Colour should carry meaning and nothing else.** The palette spends its whole
contrast budget on what broke, what is flagged and what is unproven. A sensitive
tool in the agent registry renders red, so a healthy deployment has *no red at
all* on that screen and the exception is findable without reading a label.

## 11. Mistakes made & why

**1. The 20/20 report.** Covered above, and it is the mistake of the phase. What
makes it interesting is that every individual control was honest — the evidence
was real, the queries were real, the limitations were stated. **The dishonesty
was in the selection, which no individual check could catch.** Composition of
honest parts is not automatically honest.

**2. A test that asserted an invariant instead of exercising a branch.** My
first "a failing query is a gap" test called `buildCoverageReport` and then
checked that no control was `covered` with zero evidence — a property that holds
whether or not the error path works at all. Replaced by exporting
`evaluateControl` and handing it a genuinely broken query. Fifth phase with a
version of this lesson, and I now recognise the shape on sight: *if I cannot
name what would have to break for this test to fail, it is not a test.*

**3. I pinned dependency versions I had invented.** `next@15.6.1`,
`react@19.2.0`, `@types/react@19.2.2` — none existed. `npm view` takes two
seconds and I did not spend them. Same family as inventing tool names in Phase
7 instead of reading the `tools` table: **look it up, do not remember it.**

**4. `console` almost became `dashboard`.** I nearly named the API's read
endpoints after their consumer. They are the *operator reads*; the dashboard is
one client. Naming an interface after its first caller is how a second caller
ends up with a confusing dependency.

## 12. Open questions / debt

- **The console endpoints are admin-key guarded, which is not RBAC.** One shared
  secret, no rotation, no per-user identity — so "who looked at this?" is
  unanswerable. It is listed as gap **ATL-C22** in the coverage report rather
  than quietly omitted, and it is Phase 9 work.
- **Reading the audit trail is not itself audited.** `CLAUDE.md` §12 lists "data
  access" as an event worth capturing, and we capture report *generation* but
  not report *viewing*. That is a real gap for a system whose product is
  evidence.
- **No charts.** Every screen is tables and metrics. Defensible for an MVP —
  tables are precise and charts are approximate — but a decision-volume trend
  over time would genuinely help an operator, and its absence is a choice rather
  than a conclusion.
- **Coverage recomputes on every page load.** Twenty-six aggregates per request.
  Fine at this size; a nightly materialised snapshot is what a monthly
  compliance report actually wants anyway — a figure that does not change while
  you are reading it.
- **The STR review workflow has no UI.** The API supports
  DRAFT → UNDER_REVIEW → READY_FOR_FILING with an audit event at each step, but
  the screen is read-only. A reviewer currently needs curl.
- **No accessibility audit.** Semantic HTML, real tables and sufficient contrast
  by construction, but nothing has been tested with a screen reader and there is
  no keyboard-navigation pass.
- **`formatPaise` exists twice** — once in the API (`money.ts`) and once in the
  dashboard. Deliberate, because the dashboard must not import server code, but
  two implementations of Indian digit grouping will eventually disagree. A tiny
  shared package would fix it.
