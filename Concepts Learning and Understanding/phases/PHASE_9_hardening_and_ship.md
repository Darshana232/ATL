# Phase 9 — Hardening & Ship

**Status:** ⬜ planned · *(merges the old Phase 11 and Phase 12)*

---

## What it is

The pass that turns a working project into a defensible one: a real threat
model, a security review, CI, observability, a deployment, and a rehearsed
demo.

## Why it comes last

You cannot threat-model a diagram. You threat-model **the system you actually
built**, including the shortcuts you took under time pressure.

## The steps

**1. STRIDE over our real architecture.** Walk each trust boundary and ask the
six questions — Spoofing, Tampering, Repudiation, Information disclosure, Denial
of service, Elevation of privilege — and write down the answer *and* the
residual risk for each.
→ [threat modelling](../concepts/security/10_threat-modelling-stride.md)

**2. Close the known stopgaps.**
- Replace the shared admin key with per-user sessions and RBAC.
- Rate limiting, per agent and per mandate.
- Request size limits, and a hard cap on audit payload size (already 256 KB).
- Security headers and a reviewed CORS policy.

**3. Linting and CI.** ESLint arrives here (deliberately deferred — it was
either this or churn on a codebase that was changing shape weekly). GitHub
Actions running `typecheck`, `test` and `migrate` against a throwaway Postgres.
→ [CI/CD](../concepts/engineering/05_ci-cd-and-deployment.md)

**4. Observability.** Metrics that a compliance operator would actually watch —
decisions by verdict, block reasons by rule, voucher redemption latency, chain
verification duration — plus trace IDs already threaded from Phase 1.
→ [observability](../concepts/engineering/06_observability.md)

**5. Deploy.** Managed Postgres, the API and dashboard as two deployables,
`DATABASE_URL` the only thing that really changes (ADR-0004). Wire
`/v1/health/live` to the liveness probe and `/v1/health` to readiness.

**6. The demo script.** Rehearsed, timed, with the failure paths *included* —
the blocked payment and the tamper detection are better television than the
happy path.

**7. Write `99_THE_WHOLE_MVP.md`** — the full walkthrough, written last, when
it can finally be honest.

## What you can do after it

Hand someone a URL and a threat model in the same email.

## The honest gap

A threat model is a snapshot. It is correct on the day it is written and decays
from then on. The mitigation is to date it and re-run it, not to pretend
otherwise.
