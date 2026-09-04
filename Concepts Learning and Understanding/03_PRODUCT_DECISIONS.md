# 03 — Product Decisions (and why)

`docs/DECISIONS.md` is the formal ADR log — dates, status, supersessions. This
file is the **readable version**: the decisions that shaped the *product*, in
the order they matter, each with what we rejected and what it cost us.

An interviewer rarely asks "what did you build?". They ask **"why did you build
it that way, and what did you give up?"** These are the answers.

---

## The one that everything else follows from

### D1 · The LLM proposes; a deterministic engine authorizes  (ADR-0008)

**Decision.** No language model ever decides whether a payment is permitted.
The agent may only *request*. A pure, deterministic, side-effect-free policy
engine decides, and the payment service refuses to move money without a
single-use signed voucher minted by that engine.

**Rejected.** *LLM-as-judge over the mandate* — non-deterministic,
unexplainable, prompt-injectable, unauditable. *ML risk scoring as the gate* —
that is fraud detection, a different problem with a different definition of
"correct".

**Why.** Trust has to be a property of the architecture, not of model quality.
A better model does not make agentic payments safe; a payment path the model
cannot reach does. Concretely: a fully prompt-injected agent still cannot move
money — it can only ask, and asking goes through code it doesn't control.

**Cost.** We give up flexibility. The engine can only decide things you can
write as a rule. Anything genuinely fuzzy has to become a `FLAG` for a human,
not a clever judgement.

---

## Product scope decisions

### D2 · We are authorization and evidence, not fraud detection  (ADR-0010)

**Decision.** Risk is an **advisory input**. It can raise a `FLAG`. It can
never override a deterministic `BLOCK` or manufacture a `PASS`.

**Why.** "Was this permitted?" and "was this suspicious?" have different
correctness criteria. The first must be the same every time and explainable in
numbers; the second is probabilistic and empirical. Merge them and your
verdicts stop being explainable *and* your fraud detection stops being
testable.

**Cost.** We cannot claim to catch novel fraud. That is the right trade for a
compliance product — and saying so is more credible than claiming both.

---

### D3 · Simulate the mandate rail, and say so loudly  (ADR-0009)

**Decision.** The UPI mandate rail is **SIMULATED**, behind an adapter, and
labelled that way in code, UI and docs. Payments go through a
`PaymentProvider` interface with `MockUpiProvider` (default) and
`RazorpayTestProvider` (real Razorpay test mode).

**Why we had no choice.** NPCI's **UAP (Unified Agent Protocol)** — the thing
that would actually register and authorize agents on UPI — is *still in
development*, has no public specification, and needs RBI approval. Anyone
claiming to have "built the UAP integration" today is claiming something that
cannot exist.

**Why it's fine.** Because it sits behind an interface, the simulation is
load-bearing in this *deployment*, not in the *architecture*. The day a spec
and credentials exist, a new class drops in behind an unchanged interface.

**Cost.** A judge can say "so you didn't really do payments." The answer:
Razorpay test mode is real, the authorization layer is entirely real, and the
one part we cannot do is the one part nobody outside the pilot can do.

---

### D4 · Report *control coverage*, never a compliance percentage

**Decision.** Reports say **"Control Coverage: n/20, with these named gaps"**
and attach per-control evidence. Never "98.75% COMPLIANT with RBI FREE-AI".

**Why.** FREE-AI is a committee framework of recommendations. There is no
certifying authority and no scoring methodology, so a percentage is a number
invented to look impressive. Naming your gaps is the more credible move in
front of anyone who actually knows the framework — and they might be the judge.

**Cost.** A less impressive slide. Worth it.

---

### D5 · Draft suspicious-transaction reports; never file them

**Decision.** We generate an STR **draft** with FIU-IND-style fields, route it
to a human reviewer, and mark it "ready for filing". We never say "filed".

**Why.** FIU-IND filings go through FINnet by registered reporting entities. We
are not one and have no access. Claiming otherwise is not an exaggeration, it's
a false regulatory claim.

---

### D6 · The AFA threshold is not a spending cap

**Decision.** Model two separate things:
- `MANDATE_PER_TXN_LIMIT` — user-set, **enforced** by us.
- `AFA_EXEMPTION_THRESHOLD` — regulatory (NPCI circular UPI/OC-151A, 14 Dec
  2023; ₹1,00,000 for specific MCCs), **recorded and displayed, never
  enforced** — it governs whether a UPI PIN is required, on a rail we don't
  operate.

**Why.** The research folder conflates them and calls ₹15,000 "the default
mandate cap". It isn't. Getting this right is a small detail that signals you
actually read the circular.

Card: [AFA and the exemption threshold](concepts/domain/04_afa-and-the-exemption-threshold.md)

---

### D7 · Every mandate version requires recorded consent

**Decision.** `consent_ref` and `consent_at` are `NOT NULL` on every version,
including version 1.

**Rejected.** Requiring consent only for *widening* changes (raise a limit, add
a merchant) and letting *narrowing* ones through — since narrowing can't harm
the user.

**Why.** That needs a classifier deciding whether a diff increases authority,
and that classifier would sit **in the security path**, where a bug is a silent
authority increase. `NOT NULL` has no moving parts: there is no code path that
can skip consent, because there is no code involved.

**Cost.** Friction on purely protective changes — a parent lowering a child's
limit still re-confirms. Accepted.

**Still honest about the gap:** the database enforces that a consent reference
is *recorded*, not that a human *agreed*. A real consent flow needs the
dashboard (Phase 8). That gap is written in the migration itself.

---

### D8 · Never call a third-party API on the authorization path  (ADR-0013)

**Decision.** Razorpay's public IFSC API is used at **mandate creation** and at
seed time. **Never** during authorization.

**Why this is the important half.** If a compliance verdict depended on
somebody else's uptime, then when they're down you must either block every
payment or allow every payment — and **both answers are wrong**. So the
dependency must not exist there at all.

**Bonus finding worth quoting:** of seven "keyless" public APIs we tested from
a popular community directory, three were stale — one dead, one serving HTML
instead of JSON, one now requiring a key while still advertised as keyless. A
community directory is a discovery tool, not a source of truth.

---

### D9 · Hand-seed the product catalog

**Decision.** Indian grocery/food fixtures written by hand, not a public
fake-store API.

**Why.** DummyJSON and FakeStoreAPI work and need no key — but they price in
USD, list US consumer goods, and carry **no MCC**. Our category rules key on
ISO 18245 MCCs. Hand-seeded fixtures are *more* realistic here and have zero
network dependency.

---

### D10 · Tamper-**evident**, never tamper-proof

**Decision.** That is the claim ceiling, everywhere, forever.

**Why.** A hash chain lets you *detect* modification. It does not *prevent*
someone with database superuser rights from rewriting the entire chain. Signed
checkpoints published externally raise the bar; they don't eliminate it.

Being precise about this is not modesty — it's the difference between a claim
that survives scrutiny and one that collapses on the first sharp question.

---

## Engineering decisions with product consequences

| # | Decision | The product reason |
|---|---|---|
| **D11** | TypeScript everywhere (ADR-0001) | One language for API, dashboard, agent and tests. For a solo builder, context switching between two ecosystems costs about a full phase. Types also *teach* the domain: `type Verdict = 'PASS' \| 'FLAG' \| 'BLOCK'` makes illegal states unrepresentable. |
| **D12** | API separate from dashboard (ADR-0002) | The API *is* the product — the thing a payment aggregator would operate. Separating it also makes the security boundary real rather than diagrammatic: the agent runtime sits outside and can only reach the engine over a network hop with its own auth. |
| **D13** | PostgreSQL, not a document DB (ADR-0005) | Our guarantees *are* relational: foreign keys mandate→decision→payment→audit, `CHECK` constraints as the last line of defence, transactions for velocity counting, `REVOKE` + triggers for append-only tables. A document database gives you none of the first four. |
| **D14** | Hand-written SQL migrations with checksums (ADR-0006) | In a system whose whole value is auditability, "the schema is whatever the ORM inferred" is indefensible. Also a deliberate rehearsal of the audit hash chain, at smaller scale. |
| **D15** | Integer paise, `TIMESTAMPTZ`, prefixed text IDs (ADR-0007) | `0.1 + 0.2 !== 0.3` is a curiosity in a tutorial and a defect in a payment system. A timestamp without a timezone is ambiguous in a record a regulator may read. `mnd_…` vs `mer_…` makes passing the wrong ID *visibly* wrong instead of a silent integer mix-up. |
| **D16** | Split liveness and readiness health checks (ADR-0012) | Conflating them causes a famous outage: the database blinks, every instance fails its health check, the orchestrator restarts all of them, and a recovering database now faces a thundering herd. |

---

## The decisions we have *not* made yet

Honest open questions, so nobody thinks the design is finished:

- **How a user proves consent in the UI** — Phase 8. Today we record a
  reference; we do not capture the act.
- **Multi-agent mandates** — one mandate is currently one user + one agent.
- **What happens on partial refunds** — the spend window arithmetic needs a
  rule, and we haven't written it.
- **Whether `FLAG` blocks the payment or lets it through and alerts.** Right
  now: lets it through, records it. That is a *product* call, and it is
  arguable.

---

**Next:** [04_INTERVIEW_PACK.md](04_INTERVIEW_PACK.md).
