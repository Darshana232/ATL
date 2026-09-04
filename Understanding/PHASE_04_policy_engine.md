# Phase 4 — The Policy Engine

**Status:** DONE · **Started:** 2026-09-05 · **Finished:** 2026-09-05
**Result:** 12 rules, a pure engine, 69 policy tests, 344 total.

> Sections 1–9 before any code. Sections 10–12 after.

---

## 1. What we are building

A **pure function**. It takes a mandate version, an attempted payment, a
snapshot of what has already been spent, a reading of the clock, and an
optional risk signal — and returns a typed `Decision` with a per-rule
breakdown.

That is the whole product in one sentence. Everything before this phase existed
to make this function possible; everything after exists to expose, prove or
demonstrate what it decides.

## 2. Why now

Phase 3 gave us something authoritative to evaluate against. Phase 5 needs
something to call. This is the piece in between, and it must exist before the
authorization API because "authorize" without a decision function is just an
insert statement.

Doing it earlier was impossible — there were no mandates. Doing it later would
mean building the API around a placeholder and then discovering the real engine
needs different inputs.

## 3. How it works

```
evaluate({ mandate, version, request, spend, now, risk })
   │
   │  ONE pure function call. No database, no clock, no network.
   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  EVERY rule runs. None is skipped, even after a BLOCK.               │
│                                                                       │
│   1 MANDATE_REVOKED          status = revoked?                       │
│   2 MANDATE_NOT_YET_VALID    now < validFrom?                        │
│   3 MANDATE_EXPIRY           now > validTo?                          │
│   4 MANDATE_PER_TXN_LIMIT    amount > perTxnLimit?                   │
│   5 MANDATE_WINDOW_LIMIT     spent + amount > windowLimit?           │
│   6 MERCHANT_ALLOWLIST       merchant in allowlist? (empty = DENY)   │
│   7 CATEGORY_BLOCKLIST       merchant MCC in blockedMccs?            │
│   8 TIME_WINDOW              local hour/weekday inside the window?   │
│   9 VELOCITY_LIMIT           txns in last hour >= max?               │
│  10 PAYMENT_METHOD_ALLOWED   method in permitted methods?            │
│  11 AFA_EXEMPTION_THRESHOLD  INFORMATIONAL - records, never enforces │
│  12 RISK_SIGNAL              ADVISORY - may FLAG, can never BLOCK    │
└──────────────────────────────────────────────────────────────────────┘
   │
   │  aggregate: any BLOCK -> BLOCK; else any FLAG -> FLAG; else PASS
   │  reason:    the FIRST blocking rule's reason, which carries numbers
   ▼
Decision { verdict, reason, engineVersion, evaluations[12], evaluatedAt }
```

**One real evaluation.** Mandate: ₹2,000 per transaction, ₹5,000 per week,
BigBasket only, 08:00–20:00 Asia/Kolkata, Mon–Sat. Agent requests **₹6,200**:

```
 1 MANDATE_REVOKED         PASS   status is active
 2 MANDATE_NOT_YET_VALID   PASS   valid from 2026-09-01, now is later
 3 MANDATE_EXPIRY          PASS   valid to 2026-12-31, not reached
 4 MANDATE_PER_TXN_LIMIT   BLOCK  requested ₹6,200 against a ₹2,000 limit
 5 MANDATE_WINDOW_LIMIT    BLOCK  ₹3,100 spent + ₹6,200 exceeds ₹5,000
 6 MERCHANT_ALLOWLIST      PASS   mer_bigbasket is allowed
 7 CATEGORY_BLOCKLIST      PASS   MCC 5411 is not blocked
 8 TIME_WINDOW             PASS   14:22 Mon is inside 08:00-20:00 Mon-Sat
 9 VELOCITY_LIMIT          PASS   2 in the last hour, limit 5
10 PAYMENT_METHOD_ALLOWED  PASS   upi_reserve_pay is permitted
11 AFA_EXEMPTION_THRESHOLD PASS   ₹6,200 is below the ₹1,00,000 AFA ceiling
12 RISK_SIGNAL             PASS   score 12 (LOW)

verdict BLOCK
reason  "Requested ₹6,200.00 exceeds the ₹2,000.00 per-transaction limit by ₹4,200.00."
```

Note what rules 5 through 12 did: **they still ran.** That is deliberate, and
§5 explains why.

## 4. Concepts I need first

**Pure function.** Same inputs always give the same output, and it changes
nothing outside itself. `evaluate()` reads no clock, opens no connection, logs
nothing. `now` is a *parameter*.

Three things follow, and they are the reason this design is worth the small
awkwardness of threading `now` through:

- **Testable without infrastructure.** Every rule can be exercised with plain
  objects. No database, no fake timers, no mocking library.
- **Replayable.** Feed a past decision's exact inputs back in and get the
  identical verdict. That is what makes "why was this blocked in September?"
  answerable rather than a guess.
- **Explainable.** A function with no hidden state has nothing to hide behind.

**Determinism.** `Date.now()`, `Math.random()` and network calls are the three
usual sources of non-determinism. None appears here. If the engine ever needs
randomness, the random value gets passed in too.

**Total function.** Every input produces an output; nothing throws. A rule that
cannot be evaluated returns `SKIP` rather than raising. An authorization engine
that throws on unexpected input fails *open or closed depending on the caller's
catch block*, which is not a security posture.

**Exhaustive `switch`.** With `noFallthroughCasesInSwitch` and a `never` check
in the default branch, adding a fourth verdict later becomes a **compile
error** at every place that handles verdicts, instead of a silently unhandled
case at runtime.

**Boundary values.** Every limit has three interesting inputs: exactly at it,
one below, one above. Off-by-one in a spending limit is a real money bug, so
each numeric rule gets all three.

**Signal → Rule → Evaluation → Verdict → Reason.** The explainability record,
produced as a *typed structure by code* — never prose from a model. A model can
produce plausible text about a decision it did not make; only the rule that
actually fired knows the numbers.

**Timezone conversion.** `windowStartHour: 8` means 8am **where the user is**,
but every timestamp we store is UTC. Converting needs the IANA zone, and two
things that are easy to get wrong: `hourCycle: 'h24'` returns `24` at midnight
(use `h23`), and **the weekday changes with the zone** — `2026-09-07T18:30:00Z`
is Monday in UTC and Tuesday in Asia/Kolkata. Both verified by probe.

## 5. Design choices & tradeoffs

| Choice | Alternative | Why | Cost |
|---|---|---|---|
| **Every rule runs; never short-circuit** | stop at the first BLOCK | the audit record must prove each check was *performed*. "Did you check the merchant?" is what an auditor asks, and "we stopped early" is not an answer. Also gives the user every reason at once instead of one per retry | ~11 extra integer comparisons, which is nothing |
| Verdict precedence: any BLOCK → BLOCK, else any FLAG → FLAG, else PASS | first rule wins | deterministic and order-independent for the *verdict*; only the human-readable reason depends on order | none |
| Reason = the **first** blocking rule's reason | concatenate all failures | one clear sentence is actionable; five are noise. The full breakdown is still in `evaluations` for anyone who wants it | the reason is order-dependent, so rule order is a deliberate choice |
| Rule order: identity → validity → amounts → scope → context | arbitrary | the earliest rules answer "should this mandate be usable at all?", so the headline reason is the most fundamental failure rather than an incidental one | — |
| `now` is a parameter | read the clock inside | determinism, replayability, and boundary tests that need no fake timers | every caller threads it through |
| Rules return `SKIP` rather than throwing | throw on unevaluable input | a total function cannot fail open by accident | a fourth rule-verdict value to handle |
| Risk may **FLAG**, never BLOCK or PASS | let risk override | authorization is deterministic and explainable; risk scoring is probabilistic and empirical. If a score could block, our verdicts would stop being reproducible — and the schema already enforces `is_advisory` | a genuinely suspicious transaction still completes; that is fraud detection's job, not ours |
| `AFA_EXEMPTION_THRESHOLD` is informational | enforce it as a limit | **the research conflates it with a mandate cap.** It is NPCI's AFA-exemption ceiling (UPI/OC-151A) governing whether a UPI PIN is required — on a rail we do not operate. We record and display; we do not enforce | one more evaluation row that always passes |
| Empty allowlist = **deny everything** | treat empty as "no restriction" | deny by default. The opposite reading turns an unfinished mandate into an unlimited one | a draft mandate blocks everything, which is correct but must be explained in the UI |
| Amounts compared with `>` (equal is allowed) | `>=` | "a limit of ₹2,000" means ₹2,000 is permitted. The everyday reading of the word | must be stated, since the opposite is equally implementable |
| Velocity compared with `>=` | `>` | if the limit is 5 per hour and 5 have already happened, **this one is the sixth**. The count is of *completed* transactions, not including this one | asymmetry with the amount rules, so both are commented |

### Where the LLM is, in this phase

Nowhere. That is the point. The engine is reached by Phase 5's API; the agent
can only *ask*. Not one line of this phase imports an AI SDK, and the `Decision`
type has no field a model could populate.

## 6. Files created/modified

```
apps/api/src/policy/
  types.ts        Verdict, RuleEvaluation, Decision, EvaluationInput
  rules.ts        the twelve rules, each a pure function
  rules.test.ts   boundary values on every limit, both sides
  engine.ts       evaluate(): runs all rules, aggregates, picks the reason
  engine.test.ts  aggregation, precedence, determinism, replay
  time-window.ts  IANA-aware local hour and weekday
  time-window.test.ts  midnight, DST, zone-dependent weekday
```

No database access anywhere in this directory. If a file here imports `pg`,
something has gone wrong.

## 7. How we test it

| Test | Asserts | Failure it prevents |
|---|---|---|
| every limit at `==`, `+1`, `-1` | correct side of each boundary | off-by-one in a spending limit — a real money bug |
| exactly-at-limit amount is **allowed** | `>` not `>=` | a ₹2,000 limit silently meaning ₹1,999 |
| velocity at exactly the limit is **blocked** | `>=` not `>` | the (n+1)th transaction slipping through |
| all rules present in output, even after a BLOCK | 12 evaluations always | an audit record that cannot prove a check ran |
| same inputs → identical output, twice | determinism | a verdict that depends on hidden state |
| `now` changes the verdict; the clock does not | purity | an engine that cannot be replayed |
| empty allowlist blocks every merchant | deny by default | an unfinished mandate authorising everything |
| risk HIGH produces FLAG, never BLOCK | advisory boundary | probabilistic input making verdicts unexplainable |
| risk cannot rescue a BLOCK | precedence | a score overriding a hard limit |
| reason contains the numbers | `₹` and both amounts present | "limit exceeded" instead of an explanation |
| reason names the *first* blocking rule | ordering | an incidental failure masking a fundamental one |
| 19:59 passes, 20:00 blocks (window end 20) | exclusive end | an hour of unintended authority every day |
| midnight in-zone yields hour 0, not 24 | `hourCycle: 'h23'` | every midnight evaluation misbehaving |
| weekday computed in the mandate's zone | zone-aware weekday | applying Monday's rule on a Tuesday |
| a DST zone in January and July | Intl handles the shift | a fixed offset being wrong half the year |
| SKIP when a rule cannot apply | no throw | failing open or closed by accident |

## 8. Security notes

**Threat:** an off-by-one lets a transaction exceed its limit.
**Mitigation:** three boundary tests per numeric rule, and the comparison
operator stated in a comment beside each.
**Why this one:** the bug is invisible in review and only appears at the exact
boundary — which is precisely where an attacker probes.

**Threat:** an unfinished or malformed mandate authorises more than intended.
**Vulnerability:** an empty allowlist read as "no restriction".
**Mitigation:** empty means deny, tested explicitly.
**Why this one:** fail closed. Every ambiguous absence in an authorization
system must resolve to *less* authority, never more.

**Threat:** the engine throws and the caller's `catch` decides the outcome.
**Mitigation:** a total function — `SKIP` instead of exceptions.
**Why this one:** whether a thrown error means "allow" or "deny" would then
depend on code far away from the rules, which is the worst place for a security
decision to live.

**Threat:** a probabilistic signal makes verdicts unreproducible.
**Mitigation:** risk may only raise a FLAG. Enforced here *and* by
`CHECK (is_advisory)` in the schema.
**Why both:** the code expresses the intent; the constraint means changing it
requires a migration and a review rather than one line in a service.

**Threat:** the reason text leaks something it should not.
**Mitigation:** reasons are built from amounts, limits, merchant ids and MCCs —
never from user intent text or personal data.
**Why this one:** the reason is shown to the merchant, returned to the agent,
and stored in the audit trail. It reaches more places than any other string we
produce.

## 9. What happens at scale

| Volume | What breaks first | Fix |
|---|---|---|
| any | nothing in the engine — twelve integer comparisons and one `Intl` call | — |
| high throughput | `Intl.DateTimeFormat` construction is the most expensive thing here, by far | cache formatters per timezone; there are only a handful in practice |
| 10M transactions | not the engine: the **spend snapshot** feeding it (the Phase 2 `SUM` over a window) | rollup counters, then a cache — in that order, after measuring |
| regulatory | re-explaining an old decision needs the old *rule set*, not just the old mandate | `engineVersion` is recorded on every decision; a future change ships a new version rather than editing rules in place |

The last row matters more than it looks: the mandate is versioned already, but
**the rules are versioned too**, and a decision is only re-explainable if both
are recoverable.

## 10. What I learned

**Purity is a property you can VERIFY, not just intend.** After writing the
engine I grepped the whole directory for `pg`, `Date.now`, `Math.random`,
`fetch`, `process.env` and any AI SDK. All absent — and so is `await`, which
means the engine is fully synchronous and therefore cannot be doing I/O. That
check took a minute and turns an architectural claim into a fact anyone can
re-run.

**Every verification needs a POSITIVE CONTROL.** My first two purity checks
reported "absent ✓" for everything while grep was silently failing (see §11).
The fix was to add a pattern that *must* be found — if the control returns
zero, the whole check is worthless. I now think of this as mandatory: a test
that can only ever pass is not a test, and that applies to shell checks as much
as to `it()` blocks.

**Running every rule beats short-circuiting, for a non-obvious reason.** The
instinct is to stop at the first BLOCK. But the audit record then cannot show
that the merchant check *was performed* — and "did you check X?" is exactly
what an auditor asks. Eleven extra integer comparisons buy an answer to that
question. Performance intuitions are usually wrong about what actually costs
anything.

**Comparison operators are a design decision, not a detail.** Amounts use `>`
(a ₹2,000 limit permits ₹2,000). Velocity uses `>=` (if the limit is 5 and 5
have completed, this is the sixth). The asymmetry is correct and would look
like a bug to a reviewer, so both are commented — and both have a test at the
exact boundary.

**Separating two rules that "look the same" was the sharpest call.**
`MANDATE_PER_TXN_LIMIT` and `AFA_EXEMPTION_THRESHOLD` both compare an amount to
a ceiling. Merging them, as the research does, would mean enforcing NPCI's
PIN-exemption threshold as if it were the user's spending limit — a rule
belonging to a rail we do not operate. One enforces; the other only records.

**`SKIP` is information.** "No risk provider answered" and "a provider said
this is fine" are different facts, and an audit trail that conflates them has
lost something. Same reasoning as `NULL` vs `0` for a risk score in Phase 2.

**Exhaustive `switch` with a `never` binding is free insurance.** Adding a
fourth verdict later becomes a compile error at every site that handles
verdicts, instead of a silently unhandled case in production.

**Timezone bugs hide at boundaries you have to go looking for.** Midnight
(`h24` returns 24), and the fact that the *weekday* shifts with the zone —
18:30Z is Monday in UTC and Tuesday in IST. Neither would have shown up in
casual testing; both were found by probing before writing code, and both now
have tests.

## 11. Mistakes made & why

**1. `require()` inside an ESM test file.** I reached for
`require('./rules.js')` mid-file to grab one more export instead of adding it
to the import list. Four tests failed with `Cannot find module`. *Why:* laziness
at the moment of writing — the import block was 20 lines up. *Lesson:* trivial,
but it cost a run; add the import.

**2. A verification that "passed" twice while measuring NOTHING — the most
serious mistake of this phase.** My purity check ran
`grep -rn "$pattern" src/policy/ --include=*.ts`. zsh could not expand the
unquoted glob, so grep errored and printed nothing — and my script read "no
output" as "pattern absent" and printed a tick. **Seven confident ✓ marks, all
meaningless.**

I fixed the glob and ran it again. It failed *again*, differently: I put the
file list in a shell variable and passed it unquoted, and zsh does not
word-split variables — so grep received one giant filename. More ticks, still
measuring nothing.

*Why it happened:* this is the **third** appearance of the same two lessons I
had already written down — "an empty result is not a pass" (Phase 1 mistake 3)
and "do not stuff file lists or commands into shell variables" (Phase 1 mistake
5). Knowing a lesson and *applying* it under momentum are different skills.

*What actually fixed it:* not remembering harder — adding a **positive
control**. A pattern that must be found (`RuleEvaluation`, 9 hits) proves the
check can detect anything at all. Without it, "absent" and "broken" are
indistinguishable outputs.

*Lesson:* any check whose passing condition is *absence of output* must be
paired with a control that produces output. This is now how I will write shell
verifications, and it generalises to tests: `expect(x).not.toThrow()` needs a
sibling that does throw.

## 12. Open questions / debt

- The spend snapshot is supplied by the caller, so the engine trusts it. Phase 5
  must compute it under the row lock from ADR/PHASE_02 Q4, or the limit is
  enforceable only as accurately as whatever was passed in.
- `engineVersion` is a hand-maintained constant. Nothing forces it to change
  when a rule changes — a test comparing a hash of the rule set would.
- No per-rule timing yet; `evaluation_duration_us` is measured for the whole
  decision only.
