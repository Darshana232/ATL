# Phase 5 — The Authorization API

**Status:** ⬜ planned

---

## What it is

The endpoint the agent actually calls — `POST /v1/authorizations` — and
everything that makes it safe to expose to a component we assume is
compromised.

## Why it comes here

The engine (Phase 4) can decide. This phase is about who is allowed to *ask*,
how we know the question wasn't tampered with, what happens when the network
retries, and what a `PASS` actually hands back.

## The steps

**1. Agent authentication.** An API key identifies the agent; the agent's
capabilities come from `agent_tool_grants` — deny-by-default, seeded in Phase 2.
→ [authn vs authz](../concepts/security/01_authentication-vs-authorization.md)

**2. Request signing (HMAC).** The agent signs the request body plus a
timestamp with a shared secret. We recompute and compare **in constant time**.
This proves the body wasn't modified in flight, which a bearer token alone does
not.
→ [HMAC and signed requests](../concepts/security/03_hmac-and-signed-requests.md)

**3. Replay defence.** A signature alone doesn't stop someone capturing a valid
request and sending it again. So: reject timestamps outside a small window, and
record nonces we've already seen.
→ [replay attacks](../concepts/security/05_replay-attacks-nonces-and-timestamps.md)

**4. Idempotency.** The client sends an `Idempotency-Key`. Same key → **the same
decision returned**, not a second evaluation. Essential, because networks retry
and a retried payment authorization that evaluates twice is a double charge
waiting to happen.
→ [idempotency](../concepts/backend/11_idempotency.md)

**5. The voucher.** On `PASS`, mint a token that is **signed** (HMAC-SHA256 with
a key only the engine holds), **single-use** (a `jti` recorded on redemption),
**short-lived** (~60s) and **bound** to this mandate, amount and merchant.
This is the mechanism that turns the trust boundary from a line on a diagram
into a fact.
→ [the voucher](../concepts/security/06_the-voucher-capability-token.md)

**6. Persist everything.** `authorization_requests`, `decisions`,
`rule_evaluations`, `risk_signals` — and audit events for each — all in one
transaction with the decision.

## What you can do after it

Sign a request as an agent, get back a verdict with reasons and — on PASS — a
voucher. Then send the exact same request again and get the **same** decision
back rather than a new one. Then wait 61 seconds and watch the voucher die.

## Concepts it teaches

Authentication vs authorization · HMAC · replay attacks · nonces · idempotency ·
capability tokens · constant-time comparison.

## The honest gap

The signing key is symmetric and lives in config. In production it would be an
asymmetric key in an HSM/KMS, and the voucher would be a short-lived signed
capability token. **The architecture does not change** — only where the key
lives.
