# 01 — The Idea, in Plain English

## The one sentence

**An AI agent can now spend your real money on UPI, and nobody has built the
thing that checks the charge was inside what you actually allowed — or proves
it afterwards.**

That missing thing is what we are building. Its name in the repo is
**ATL-India — Agentic Trust & Compliance Layer**.

---

## 1. What actually changed in the world

This is not a "what if AI agents could shop" project. It already happened:

- **Oct 2025** — NPCI + Razorpay + OpenAI ran a live pilot: you buy things
  inside ChatGPT, it settles over UPI. Built on **UPI Reserve Pay** and
  **UPI Circle**. BigBasket was the first merchant.
- **Feb 2026** — Razorpay and NPCI extended the same thing to Claude, with
  Zomato, Swiggy and Zepto.

So software is already moving real rupees for real people, without a human
looking at the final amount.

---

## 2. Why that breaks the old model

When **you** pay on UPI, three things happen in the same instant:

- you see the amount (₹4,870)
- you decide
- you type your UPI PIN

Consent, amount and moment are **fused into one act**. The PIN *is* the
authorization.

When an **agent** pays, that fusion snaps:

```
You, on Monday:      "buy my groceries, ₹5,000 a week, BigBasket only"
Agent, on Thursday:  picks items, picks the total, picks the moment
                     charges ₹4,870
                     nobody looked at ₹4,870
```

You authorized a **policy**. The agent produced a **transaction**. Whether the
second one is inside the first is now a genuine question — and one that
somebody has to answer *before* the money moves, and be able to answer *again*
six months later when a customer disputes it.

> **Analogy.** Handing an agent your card is like giving a new employee the
> company credit card. You don't want to approve every coffee. You want a
> spending policy, a receipt for every charge, and a ledger nobody can quietly
> edit. Right now the agent world has the card and none of the other three.

---

## 3. The three questions with no infrastructure answer

| | Question | What exists today |
|---|---|---|
| **Authorization** | Was this specific ₹4,870 inside what the human permitted? | Nothing standard. Merchants improvise. |
| **Evidence** | Can you prove it later, in a form nobody could have edited? | A log file an engineer can `UPDATE`. That is a claim, not evidence. |
| **Explanation** | When it is blocked, can the user, the merchant and a compliance officer each understand *why*? | "Our model declined it." That is an apology, not an explanation. |

Our product answers all three, and the third one is the part people
underestimate.

---

## 4. What this is *not*: fraud detection

This distinction is the sharpest idea in the project, and it is a very common
interview question. Keep them apart:

| | **Authorization** (us) | **Fraud detection** (not us) |
|---|---|---|
| Question | "Was this **permitted**?" | "Was this **suspicious**?" |
| Method | deterministic rules | statistics / machine learning |
| Right answer | the *same* verdict every time, with the same reason | a probability that improves with more data |
| Failure | a wrong rule — findable, fixable, testable | a false positive — tunable, never eliminated |
| Explanation | "₹6,200 requested against a ₹5,000 limit; over by ₹1,200" | "risk score 0.87" |

If you merge them you get the worst of both: verdicts you cannot explain, and
fraud detection you cannot test. So in our system a **risk score is advisory
only** — it can raise a `FLAG`, but it can never overturn a `BLOCK` or
manufacture a `PASS`.

---

## 5. Who uses it

| Person | What they get |
|---|---|
| **End user** | Set a spending policy for your agent, revoke it instantly, see every charge and the reason it was allowed |
| **Merchant compliance lead** (BigBasket, Zomato) | Watch agent transactions, investigate blocks, export evidence |
| **Payment aggregator compliance officer** | Triage flagged breaches at agent volume; draft regulatory reports |
| **Agent developer** | A clear `authorize → then pay` API, so you know *before* you try |
| **Auditor / regulator** (future) | Verify nothing was altered after the fact |

**Honesty note, and say this out loud in a pitch:** no merchant interviews have
happened. The customer quotes in `Research/` appear to be fabricated. We treat
merchant demand as an **untested hypothesis**, not validation. Judges respect
that; they catch the alternative.

---

## 6. The volume argument (the real reason this becomes urgent)

A human makes maybe 1–5 payments a day. **An agent in a retry loop can make
500.** Every compliance workflow that exists today is human-paced — a
suspicious-transaction report reportedly takes an analyst ~45 minutes to draft.

You cannot hire your way out of that; the arithmetic does not work. It has to
be *generated*. And generating evidence requires a machine-readable decision
record — which is exactly the thing that does not exist yet.

---

## 7. The regulation, dated honestly

- **RBI FREE-AI** — a committee framework (13 Aug 2025): 7 "sutras", 6 pillars,
  26 recommendations. Two of them — **Accountability** and **Explainability** —
  describe our product almost exactly. It is a *framework of recommendations*,
  **not a certifiable standard**: there is no scoring authority. So we report
  "Control Coverage: n/20 with named gaps", never "98% compliant".
- **DPDP Rules 2025** — notified 13 Nov 2025 but **phased**: penalties and
  Consent Manager registration from **13 Nov 2026**, full obligations from
  **13 May 2027**.
- **PMLA / FIU-IND** — suspicious transaction reports are filed through FINnet
  by registered entities. We are not one. We generate a **draft for a human**,
  and never claim to file.

Why the precision helps the pitch: "you are non-compliant today" is false and a
judge may know it. "Obligations land in about eight months and the control you
are missing is machine-generated evidence" is true, checkable, and sounds more
urgent *because* it is precise.

---

## 8. The thesis, in one box

> **The LLM proposes. A deterministic engine authorizes. An append-only,
> hash-chained log proves it. Nobody has to trust the model.**

Three consequences that drive literally every technical decision in this repo:

1. **Trust is a property of the architecture, not of model quality.** A smarter
   model does not make agent payments safe. A payment path the model *cannot
   reach* does.
2. **Explainability is a data-structure problem, not a prompting problem.**
   `Signal → Rule → Evaluation → Verdict → Reason` is a typed record emitted by
   code. Ask a model to explain a decision and you get plausible prose — which
   in a regulatory context is not the same thing as the reason.
3. **Only a payment company can build this properly**, because it needs the
   mandate, the merchant identity, the category code and the settlement result
   in one place. That is the moat — and also the honest limit of our MVP: we
   build the interface a payment aggregator would run, with the rail simulated.

---

## 9. What would make this fail

Write it down before optimism sets in — and say it when a judge asks:

- **Merchants may not pay for it.** Compliance is insurance: low probability,
  high damage, famously hard to sell before the incident.
- **RBI's eventual agent framework may contradict our rules.** Mitigated by
  keeping rules modular and the audit schema stable. Not eliminated.
- **The volume may arrive later than we think.** Pilots are small.
- **A payment aggregator could just build it in-house.** We have no moat
  against the incumbent whose position makes the product possible.

---

**Next:** [02_THE_SYSTEM.md](02_THE_SYSTEM.md) — how the thing is actually put
together.
