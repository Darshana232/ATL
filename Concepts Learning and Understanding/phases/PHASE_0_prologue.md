# Phase 0 — Prologue: the repo and the rules

**Status:** ✅ done · **Commits:** `cb1ce09`, `c87e6b0`, `096aea3`, `a740dd8`,
`2cb7f91`, `3557d36`

---

## What it is

Before any product code: set up the repository, write down the working
agreement, and — the unusual part — **audit the research the project was based
on**.

## Why it comes first

Because most of the input material was wrong, and building on it would have
produced a confident, well-engineered system making false regulatory claims.

## The steps

**1. Import the research corpus and the engineering protocol.**
~15,000 lines of strategy material committed *for provenance*, not because it
is accurate — so every correction applied to it is traceable.

**2. Initialise the workspace.** npm workspaces (not pnpm — `corepack enable`
failed with `EACCES` on a root-owned `/usr/local/bin`, and running `sudo` as a
side effect of project setup was declined). TypeScript config shared from the
root.

**3. Write the decision log.** `docs/DECISIONS.md`, append-only. To reverse a
decision you add a new entry that supersedes the old one; you never edit
history.

**4. Write the reality check.** `docs/RESEARCH_REALITY_CHECK.md` splits every
research claim into three buckets:

| Bucket | Meaning | Examples |
|---|---|---|
| **VERIFIED** | safe to state, with a source | the Oct 2025 NPCI/Razorpay/OpenAI pilot; FREE-AI's 7 sutras dated 13 Aug 2025; the AFA circular UPI/OC-151A |
| **CORRECTED** | the research is wrong or misleading | "98.75% COMPLIANT" (no scoring authority exists); `CHECK (true)` for immutability (does nothing); "AFRI provides risk scores" (**AFRI does not exist**) |
| **UNVERIFIED** | do not build on, do not quote | "$1.5T by 2030", "50M ChatGPT shopping queries/day", internally inconsistent market sizes |

**5. Flag the fabrications prominently.** The research contains quotes
attributed to a "Bigbasket Compliance Lead" and bylines like "Razorpay Founder".
No interviews happened; the project has no affiliation with any company named.
A warning sits at the top of the README, not buried in a doc nobody opens.

**6. Evaluate external APIs.** Result: adopt Razorpay's keyless public IFSC API
for cold-path use only; hand-seed everything else. Three of seven "keyless"
APIs tested from a popular community directory were stale.

## What you can do after it

Explain, with sources, exactly which claims about this space are true — which
is a surprisingly rare thing to be able to do.

## Concepts it teaches

- [Git as a decision log](../concepts/engineering/03_git-as-a-decision-log.md)
- [Monorepos and workspaces](../concepts/engineering/04_monorepo-and-workspaces.md)

## The honest gap

Auditing the research does not validate the *market*. Criterion B1 — merchant
validation — is still unmet, and Phase 0 makes that visible rather than
solving it.
