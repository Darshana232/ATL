# Understanding ATL-India

This folder is the **learning record** for the project: what we built, why, what
broke, and what I now understand that I did not before.

It is deliberately separate from `docs/`:

| Folder | Audience | Question it answers |
|---|---|---|
| `docs/` | someone operating or extending the system | "how does this work, and what was decided?" |
| `Understanding/` | me, six months from now, and anyone learning from this | "why does this work, and what did building it teach?" |

---

## How to use this folder

**Reading it cold?** `01_THE_PROBLEM.md` → `02_ARCHITECTURE_OVERVIEW.md` →
`99_THE_WHOLE_MVP.md`. That is the whole system in about 25 minutes.

**Working on a phase?** Open its `PHASE_xx` file. Sections 1–9 are written
*before* any code, sections 10–11 *after*.

**Looking for a decision?** `docs/DECISIONS.md`. This folder explains concepts;
that file records choices.

---

## The two-halves rule

Every `PHASE_xx` file is written **twice**:

- **Before the phase** — sections 1–9: what, why now, how it works, concepts,
  design choices, files, tests, security, scale.
- **After the phase** — sections 10–12: what actually got built, what broke and
  why, what I learned, what debt remains.

The reason is simple. Documentation written only in advance is a **guess**.
Documentation written only afterwards has **lost the reasoning** — you can no
longer recover the alternatives you rejected, because the code only shows the
one you chose. Both halves in one file is the format real engineering teams use
for design docs, and the "after" half is consistently the more valuable one.

A rule to keep it honest: **if a section 10 or 11 is empty, that phase is not
done**, no matter what the code does.

---

## Index

| File | Contents | Status |
|---|---|---|
| [01_THE_PROBLEM.md](01_THE_PROBLEM.md) | Problem, users, thesis, Indian regulatory landscape (verified vs assumed) | ✅ |
| [02_ARCHITECTURE_OVERVIEW.md](02_ARCHITECTURE_OVERVIEW.md) | Trust zones, the voucher idea, end-to-end flow | ✅ |
| [PHASE_00_repo_and_decisions.md](PHASE_00_repo_and_decisions.md) | Git as a decision log | ✅ done |
| [PHASE_01_foundation.md](PHASE_01_foundation.md) | Config, logging, pool, migrations, health | ✅ done |
| [PHASE_02_database_schema.md](PHASE_02_database_schema.md) | The domain model | 🔄 before-half written |
| PHASE_03_mandates.md | Versioned authorization objects | ⬜ |
| PHASE_04_policy_engine.md | Deterministic rules — **the best engineering lesson here** | ⬜ |
| PHASE_05_authorization_api.md | HMAC, idempotency, replay, the voucher | ⬜ |
| PHASE_06_audit_hash_chain.md | Hashing, canonical serialization, append-only | ⬜ |
| PHASE_07_payments.md | Orders, capture, webhooks, adapters | ⬜ |
| PHASE_08_agent_runtime.md | Tool calling, MCP, prompt injection | ⬜ |
| PHASE_09_dashboard.md | Information architecture, states, fintech UX | ⬜ |
| PHASE_10_reports_certification.md | Evidence-based control mapping | ⬜ |
| PHASE_11_security.md | STRIDE over our real diagram | ⬜ |
| PHASE_12_observability_deploy.md | CI, deploy, and where we break at scale | ⬜ |
| 99_THE_WHOLE_MVP.md | Written last: the full walkthrough and demo script | ⬜ |

---

## Glossary

Terms that appear constantly. If a phase file uses a word not defined here,
that is a bug in the file.

**Agent** — a program driven by a language model that acts on a user's behalf.
Here: it discovers products, builds a cart, and *requests* payment
authorization. It never grants it.

**Mandate** — the standing permission a user gives an agent: how much, where,
what category, for how long. The user authorizes a **policy**, not a
transaction. This single sentence is why the whole system needs to exist.

**Authorization** — deciding whether a specific attempted payment falls inside
the mandate. Deterministic, explainable, and our core product.

**Authentication** — proving *who* is calling. Different question from
authorization, and constantly confused with it.

**Verdict** — the policy engine's output: `PASS`, `FLAG` or `BLOCK`. `FLAG`
means allowed but recorded as suspicious for human review.

**Signal → Rule → Evaluation → Verdict → Reason** — the shape of every
explanation, produced by code as a typed record. Never prose from a model.

**Voucher** — a single-use, short-lived, signed token the policy engine mints on
`PASS`. The payment service refuses to move money without one. This is what
makes "the LLM cannot pay" a structural fact rather than a promise.

**Hash chain** — each audit record stores the hash of the previous one, so
altering an old record breaks every hash after it. Gives **tamper-evidence**
(you can detect a change), not tamper-proofing (you cannot prevent one).

**Idempotency** — the same request sent twice has the same effect as once.
Essential when networks retry, which they always do.

**Replay attack** — capturing a valid signed request and sending it again.
A signature alone does not stop this; you need a timestamp window plus a
record of used nonces.

**MCC (Merchant Category Code)** — ISO 18245 four-digit code for what a merchant
sells. `5411` grocery, `5812` restaurants, `5921` liquor, `7995` gambling. Our
category rules key on MCC because a code is harder to game than a product title.

**AFA (Additional Factor of Authentication)** — the UPI PIN step. NPCI circular
UPI/OC-151A (14 Dec 2023) raised the AFA-exempt ceiling for UPI Autopay from
₹15,000 to ₹1,00,000 for specific MCCs. **This is a regulatory threshold, not a
mandate spending cap** — the research conflates them and we do not.

**UPI Reserve Pay / UPI Circle** — the existing NPCI rails the live
Razorpay/NPCI agentic pilots are built on: pre-authorized limits and delegated
payments.

**UAP (Unified Agent Protocol)** — NPCI's proposed standard for registering and
authorizing AI agents on UPI. **Still in development, no public specification,
requires RBI approval.** We cannot implement it; we simulate our own mandate
rail behind an adapter.

**FREE-AI** — RBI's *Framework for Responsible and Ethical Enablement of AI*,
committee report of 13 Aug 2025: 7 sutras and 6 pillars. A framework of
recommendations, **not a certifiable standard** — there is no scoring authority,
which is why we report control coverage and never a compliance percentage.

**DPDP** — India's Digital Personal Data Protection regime. Rules notified
13 Nov 2025 but **phased**: penalties and Consent Manager registration from
13 Nov 2026, full obligations from 13 May 2027.

**STR (Suspicious Transaction Report)** — a report filed with FIU-IND under
PMLA. We generate **drafts for human review**. We never claim to file one.

**Paise** — 1/100 of a rupee. All money in this system is an integer number of
paise. Never a float. `0.1 + 0.2 !== 0.3` is a curiosity in a tutorial and a
defect in a payment system.
