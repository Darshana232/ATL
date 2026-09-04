# 01 — The Problem

## The one-sentence version

An AI agent can now spend real money on India's payment rails, and there is no
standard way to prove a given charge was inside what the human actually
permitted.

---

## 1. What changed

This is not hypothetical, and that matters for the pitch:

- **Oct 2025** — NPCI, Razorpay and OpenAI launched a live agentic-payments
  pilot: purchases completed inside ChatGPT, settled over UPI, built on
  **UPI Reserve Pay + UPI Circle**. Axis Bank and Airtel Payments Bank as
  banking partners, BigBasket as the first merchant.
- **Feb 2026** — Razorpay and NPCI extended the same capability to Claude, in
  pilot, with Zomato, Swiggy and Zepto.

So agents are already moving money on national rails, for real users.

## 2. Why agent payments break the existing model

When a human pays over UPI, the authorization **is** the human. They saw the
amount on screen and typed their UPI PIN. Consent, amount and moment are fused
into one act.

When an agent pays, that fusion breaks:

```
Human pays                          Agent pays
─────────────────────────           ─────────────────────────────────────
sees ₹4,870                         human said "groceries, ₹5,000/week,
                                    BigBasket only" — days ago
enters PIN for THAT charge
                                    agent picks the items, the total,
consent = amount = moment           the moment. Nobody looks at ₹4,870.

                                    consent is a POLICY.
                                    the charge is an INFERENCE from it.
```

The user authorized a **policy**. The agent produced a **transaction**. Whether
the second is inside the first is now a question somebody has to answer — and
answer in a way that survives being asked again in six months by an auditor, a
disputing customer, or a court.

## 3. The three questions with no infrastructure answer

**Authorization.** Was this specific ₹4,870 charge inside what the human
permitted? Someone has to check the amount, the merchant, the category, the
frequency, the time window and the expiry — *before* money moves, not after.

**Evidence.** Can you prove it later, in a form nobody could have quietly edited?
A log file that an engineer with database access can `UPDATE` is not evidence.
It is a claim.

**Explanation.** When it is blocked, can the merchant, the user, and a compliance
officer each understand *why*? "Our model declined it" is not an explanation. It
is an apology.

## 4. Why this is not fraud detection

These get conflated constantly, and keeping them apart is the sharpest idea in
the project.

| | Authorization (us) | Fraud detection |
|---|---|---|
| Question | "Was this **permitted**?" | "Was this **suspicious**?" |
| Method | deterministic rules | statistical / ML |
| Correct output | the same verdict every time, with the same reason | a probability that improves with data |
| Failure mode | a wrong rule — findable, fixable, testable | a false positive — tunable, never eliminated |
| Explanation | "₹6,200 requested against a ₹5,000 per-transaction limit; over by ₹1,200" | "risk score 0.87" |

Merging them would be a genuine design error: our verdicts would stop being
explainable, and our fraud detection would stop being testable. So risk is an
**advisory input** in our system — it can raise a `FLAG`, but it can never
override a deterministic `BLOCK` or manufacture a `PASS` (ADR-0010).

## 5. Who uses this

| User | What they do with it | What they cannot do today |
|---|---|---|
| Merchant compliance lead (BigBasket, Zomato) | Watch agent transactions, investigate blocks, pull evidence | Produce an audit trail of agent decisions in any standard format |
| Payment aggregator compliance officer | Review flagged breaches, approve STR drafts | Triage agent-scale breach volume by hand |
| End user | Set a mandate, revoke it, see what their agent did and why | Bound an agent's spending precisely, or audit it afterwards |
| Agent developer | Integrate against a clear authorize-then-pay API | Know whether a payment will be allowed *before* attempting it |
| Auditor / regulator (future) | Verify integrity, sample decisions | Verify that nothing was altered after the fact |

**Honesty note.** No merchant interviews have happened. Criterion B1 in the
buildathon rubric is currently **unmet**, and the merchant quotes in `Research/`
appear to be fabricated for the pitch — see
`docs/RESEARCH_REALITY_CHECK.md` item 10. The correct move is to state this as
an untested hypothesis, not to recite an invented quote.

## 6. Why the volume argument is the real one

A human makes maybe one to five payments a day. An agent in a retry loop can
make five hundred. Every compliance workflow that exists today is human-paced:
the research claims roughly 45 minutes of analyst time to draft one STR
(plausible, unverified). You do not fix that by hiring; the arithmetic does not
work. It has to be generated, and generated evidence requires a machine-readable
decision record — which is exactly what does not exist yet.

## 7. The regulatory landscape — verified, and honestly dated

Full sourcing in `docs/RESEARCH_REALITY_CHECK.md`.

**RBI FREE-AI** — committee report, **13 Aug 2025**, chaired by Prof. Pushpak
Bhattacharyya (IIT Bombay). Seven sutras (Trust, People First, Innovation,
Fairness, Accountability, **Explainability**, Resilience) and six pillars
(Infrastructure, Policy, Capacity, **Governance**, Protection, **Assurance**),
26 recommendations. Accountability and Explainability are the two that
describe our product almost exactly.

*It is a framework of recommendations, not a certifiable standard.* There is no
FREE-AI certification body and no scoring methodology. So we report
**Control Coverage: n/20 with named gaps** and never a compliance percentage.
The research's "98.75% COMPLIANT" is indefensible.

**DPDP Rules 2025** — notified **13 Nov 2025**, but **phased**: the Data
Protection Board is operational immediately; Consent Manager registration and
penalties from **13 Nov 2026**; full notice, consent, security and data-rights
obligations from **13 May 2027**.

This correction improves the pitch rather than weakening it. "You are
non-compliant today" is false and a judge may know it. "Obligations land within
roughly eight months, and the control you are missing is machine-generated
evidence" is true, checkable, and more urgent-sounding *because* it is precise.

**PMLA / FIU-IND** — reporting entities must file STRs on suspicious activity.
Filing happens through FINnet by registered entities. We have neither access nor
authorization, so we generate **drafts** and route them to a human. We never
claim to file.

**NPCI UAP** — the Unified Agent Protocol would register, verify and authorize
agents on UPI. It is **still in development**, has no public specification, and
requires RBI approval. We therefore cannot implement it. Our mandate rail is our
own design, behind an adapter, labelled `SIMULATED`. Anyone claiming to have
built "the UAP integration" today is claiming something that cannot exist.

## 8. The product thesis

> **The LLM proposes. A deterministic engine authorizes. An append-only,
> hash-chained log proves it. Nobody has to trust the model.**

Three consequences that drive every later decision:

1. **Trust is a property of architecture, not of model quality.** A better model
   does not make agentic payments safer. A payment path the model *cannot reach*
   does.
2. **Explainability is a data-structure problem, not a prompting problem.**
   `Signal → Rule → Evaluation → Verdict → Reason` is a typed record emitted by
   code. If you ask a model to explain a decision, you get plausible prose, not
   the reason — and in a regulatory context those are not the same thing.
3. **Only a payment company can build this properly.** It requires sitting in
   the authorization path with the mandate, the merchant identity, the MCC and
   the settlement outcome in one place. That is the moat — and also the honest
   limit of our MVP: we build the interface a payment aggregator would run, with
   the rail simulated.

## 9. What would make this fail

Worth writing down now, before optimism sets in:

- **Merchants may not pay for it.** Compliance is insurance: low-probability,
  high-damage. Insurance is a famously hard sell until the incident.
- **RBI's eventual agent framework may contradict our rule set.** Mitigated by
  keeping rules modular and the audit schema stable — but not eliminated.
- **The volume argument may arrive later than predicted.** Pilots are small. If
  agent payments stay small through 2027, the urgency evaporates.
- **A payment aggregator may simply build it in-house.** We have no moat against
  the incumbent whose position makes the product possible in the first place.

None of these are reasons not to build it. They are the things to say out loud
when someone asks what could go wrong — which, per the assessment criteria (B3,
B6), is a question we want to be asked.
