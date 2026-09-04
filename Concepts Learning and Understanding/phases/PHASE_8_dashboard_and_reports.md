# Phase 8 — Dashboard & Reports

**Status:** ⬜ planned · *(merges the old Phase 9 and Phase 10)*

---

## What it is

Every human surface: a Next.js dashboard, and the compliance reports rendered
inside it. They merge because the reports *are* screens — splitting them meant
building the shell twice.

## Why it comes here

Because it should be built on something real. A dashboard over a fake backend
teaches you nothing and demos badly the moment anyone clicks twice.

---

## Part A — The dashboard

**Screens:**

| Screen | Answers |
|---|---|
| Mandates | what has this user permitted, and at which version? |
| Mandate detail + version history | what changed, when, and on what consent? |
| Decision feed | what did agents try, and what did we decide? |
| Decision detail | **the explanation** — every rule, its inputs, its verdict |
| Audit explorer + verify | is the chain intact? |
| Agents | what tools does each agent hold? |

**The one screen that sells the product** is decision detail: seven rules, each
with the actual numbers, each PASS or FAIL, and a plain sentence. Nobody else
can show that page, because nobody else stores the evaluation as data.

**Engineering points that matter here:**
- Every screen has **four states** — loading, empty, error, loaded. Skipping
  empty and error states is the single most common junior mistake.
  → [UI states](../concepts/frontend/05_ui-states.md)
- Money is formatted at the **edge only**. Paise everywhere else.
- **SIMULATED** badges are rendered from the provider name, not hard-coded, so
  they cannot go stale.
- Server components for data fetching, client components only where there's
  interaction.
  → [Next.js rendering](../concepts/frontend/03_nextjs-server-vs-client.md)

---

## Part B — The reports

**1. FREE-AI control coverage.** A table of ~20 controls mapped to RBI FREE-AI
sutras and pillars, each with **evidence generated from our own database** — a
query, a count, a link to audit rows. Output: **"Coverage: n/20, with these
named gaps."**
Never a percentage. There is no certifying authority and no scoring
methodology, so a percentage would be a number invented to look good.

**2. STR draft.** For flagged transactions: a FIU-IND-*style* draft with the
expected fields, routed to a human reviewer, marked "ready for filing".
**Never "filed"** — filing goes through FINnet by registered reporting entities,
and we are not one.

**3. DPDP processing register.** What personal data we hold, why, for how long,
and what minimisation controls exist — with the log-redaction rules from Phase 1
cited as actual evidence.

→ [FREE-AI, DPDP and STR](../concepts/domain/05_rbi-free-ai-dpdp-and-str.md)

## What you can do after it

Show a compliance officer a page, and have them understand it without you
talking.

## The honest gap

This is also where **real consent capture** finally lands — the thing Phase 3
could only record a reference to. Until this phase ships, the consent story is
half-built, and the docs say so.
