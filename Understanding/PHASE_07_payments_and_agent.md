# Phase 7 — Payments and the Agent Runtime

**Status:** IN PROGRESS · **Started:** 2026-09-05
**Result:** _(sections 10–12 stay empty until the phase is finished)_

> Sections 1–9 before any code. Sections 10–12 after.

---

## 1. What we are building

Both halves of the **outside** of the trust boundary, which is why ADR-0014
merged them: one adapts to a payment rail, one adapts to a language model, and
neither is a demo without the other.

**Payments.** A `PaymentProvider` interface with a simulated UPI implementation
and a real Razorpay test-mode implementation, plus the endpoint that **redeems a
voucher**. This is where the voucher stops being a token in a JSON response and
becomes the thing without which money cannot move.

**The agent runtime.** A shopping agent that takes a natural-language
instruction, searches a catalog, builds a cart, asks ATL-India for
authorization, and — only if it receives a voucher — pays. It gets exactly the
tools `agent_tool_grants` permits, and no others.

And the test the whole project exists to pass: **a fully prompt-injected agent
still cannot move money.**

## 2. Why now

Phase 5 mints vouchers nothing redeems. Phase 6 verifies a trail with no payment
events in it. Both are half-features until something spends.

The agent has to come with it, because "the LLM never has payment authority"
(ADR-0008) is currently a claim about a component that does not exist. Until
there is a real LLM in a real loop with real tools, the strongest thing we can
say is "we did not write the bad version".

## 3. How it works

```
  USER  "Order this week's groceries, under two thousand rupees"
    │
    ▼
┌─────────────────── ZONE 1 · UNTRUSTED ─────────────────────┐
│  AGENT RUNTIME                                              │
│    LLM parses intent            ← a PROPOSAL, never a       │
│    LLM chooses products           decision                  │
│    tools: search_products, get_product, create_cart,        │
│           request_authorization, execute_payment            │
│    NOT granted: modify_mandate, delete_audit_log,           │
│           export_all_users  ← refused before the model's    │
│                                output is even considered    │
└───────────────────────────┬─────────────────────────────────┘
                            │  HTTP + Ed25519 signature
                            ▼
┌─────────────────── ZONE 2 · TRUSTED ────────────────────────┐
│  POST /v1/authorize    13 deterministic rules               │
│      PASS/FLAG → voucher      BLOCK → voucher: null         │
│                            │                                │
│  POST /v1/payments         │  requires a valid voucher      │
│      verify MAC ─ not expired ─ claims match the request    │
│      INSERT payments (voucher_jti UNIQUE) ← single use      │
│      provider.authorize() → provider.capture()              │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
┌─────────────────── ZONE 3 · EVIDENCE ───────────────────────┐
│  PAYMENT_CAPTURED, PAYMENT_FAILED … into the hash chain     │
└─────────────────────────────────────────────────────────────┘
```

**The whole architecture is that first arrow.** The agent cannot call
`provider.capture()`. It can only call `POST /v1/payments`, which demands a
token only the policy engine can mint.

## 4. Concepts I need first

**Authorize vs capture.** Two steps, on purpose. *Authorize* reserves the money
and confirms the payer can pay; *capture* actually moves it. Splitting them is
what lets a merchant confirm stock before charging, and it is what makes
`created → authorized → captured` a real state machine rather than decoration.
Our `payments` trigger has enforced those transitions since Phase 2.

**Webhook verification.** A webhook is an unauthenticated HTTP request from the
internet claiming to be your payment provider. Anyone can send one. The
signature — HMAC over the **raw body** with a shared secret — is the only thing
distinguishing a real settlement notification from an attacker announcing that a
payment succeeded. Same rule as Phase 5: hash the raw bytes, verify before
parsing.

**Webhooks are at-least-once.** Providers retry on any non-2xx, including a
timeout after we already succeeded. A handler that is not idempotent will
double-capture. Ours keys on the provider's event id.

**Tool-level authorization.** The agent asks for a tool by name; we check
`agent_tool_grants` before the tool exists as far as the model is concerned. An
ungranted tool is not "refused when called" — it is **never offered**, and also
refused if called anyway. Both, because the model can hallucinate a tool name.

**Prompt injection.** The model reads text it did not write — a product
description, a review, a merchant's name — and that text contains instructions.
There is no known way to make a model reliably ignore them. **So the defence is
not to try.** The agent's *authority* is what is bounded, not its obedience. An
injected agent does exactly what the attacker says, and what it says is "ask
ATL-India for a ₹99,999 payment", and ATL-India says no.

**Money is integer paise, everywhere.** Razorpay's own API takes `amount` in
paise. A cart total is a sum of integers, never a float.

## 5. Design choices & tradeoffs

**1 — The payment endpoint re-verifies everything the voucher claims.**
It checks the MAC, the expiry, *and* that the amount and merchant in the request
match the amount and merchant inside the token. A voucher for ₹1,240 at
BigBasket presented against a ₹1,240 request at a liquor store is refused.
*Why not just trust the token?* Because a token is a claim about what was
approved; matching it to what is being attempted is what makes it a capability
rather than a bearer credential.

**2 — Single use is a database constraint, not a lookup.**
`payments.voucher_jti UNIQUE` plus `payments.decision_id UNIQUE`. Two perfectly
concurrent redemptions both attempt the INSERT and one loses.
*Rejected:* `SELECT … WHERE jti = ?` then INSERT — that is check-then-write, and
it loses the race a unique index wins.

**3 — `MockUpiProvider` is the default and is deterministic.**
Same input, same outcome, including its failures: an amount ending in `.13`
fails, so the failure path is demonstrable and testable without waiting for a
real decline. Every row it writes carries `provider = 'mock_upi'`, so a report
physically cannot present simulated settlements as real ones.

**4 — `RazorpayTestProvider` uses the real API, and is honest about which part
is real.** Razorpay test mode is a genuine integration: real API, real orders,
real test payments, no real money and no full KYC. What is **not** real is the
*agentic mandate rail* — Razorpay's agentic-payments product is a live pilot
with no public developer API (RESEARCH_REALITY_CHECK item 1). So: real payment
execution, simulated mandate authorization, and both labelled.

**5 — The LLM is behind an adapter too.**
`AgentProvider` with `MockAgentProvider` (deterministic, offline, no API key)
and `ClaudeAgentProvider` (real Anthropic API). The mock is the default so the
demo, the tests and CI never depend on a key or a network.

**6 — The catalog is hand-seeded Indian data with real MCCs.**
ADR-0013 already rejected DummyJSON/FakeStoreAPI: US goods, USD prices, **no
MCC** — and our category rules key on ISO 18245 MCCs. A new migration adds
`products`.

**7 — MCP is implemented as a real stdio server, and it reuses the same tool
definitions.** Not a second implementation of the tools with a second set of
scope checks — that is how a security boundary develops a hole. One tool
registry, one authorization check, two transports.

### Where the LLM is, in this phase

**Finally, everywhere it should be — and nowhere it should not.**

Allowed: parsing intent, formulating catalog queries, ranking products, writing
a human-readable summary of a decision *already made*.

Forbidden, structurally: deciding whether a payment is permitted; reaching the
payment provider; minting a voucher; writing an audit event directly.

## 6. Files created/modified

```
apps/api/src/
  providers/payment.ts        PaymentProvider + MockUpi + RazorpayTest
  providers/catalog.ts        product search, behind an interface
  repositories/payment.ts     insert + lifecycle transitions
  routes/payments.ts          POST /v1/payments, GET /v1/payments/:id
  routes/webhooks.ts          POST /v1/webhooks/razorpay
  webhooks/signature.ts       raw-body HMAC verification
  agent/tools.ts              one tool registry + scope enforcement
  agent/provider.ts           AgentProvider + Mock + Claude
  agent/runtime.ts            the shopping loop
  agent/injection.test.ts     THE test
  mcp/server.ts               stdio MCP server over the same registry
  db/migrations/0008_catalog.sql
  demo/agent-demo.ts          end-to-end: intent -> cart -> authorize -> pay
```

## 7. How we test it

| Claim | The test that would fail |
|---|---|
| No voucher, no payment | POST /v1/payments with no token → 401 |
| A forged voucher is refused | flip one character of the MAC |
| An expired voucher is refused | mint with `exp` in the past |
| A voucher cannot be spent twice | redeem, redeem again → 409, one row |
| Concurrent redemption yields ONE payment | two parallel requests, one wins |
| A voucher for a different amount is refused | claims/request mismatch |
| A voucher for a different merchant is refused | ditto |
| A BLOCK cannot be paid | full flow, assert no voucher and no payment |
| A duplicate webhook does not double-capture | send twice, assert one capture |
| A forged webhook is refused | wrong signature → 401 |
| An ungranted tool is not offered | assert the tool list for a scoped agent |
| An ungranted tool is refused when called anyway | call it directly |
| **An injected agent cannot pay** | product description contains an override |
| A hostile merchant name cannot escalate | injection via catalog data |
| The agent cannot exceed the mandate | ask for ₹6,200 under a ₹2,000 limit |

**The injection tests are the ones that matter.** They must use a *real* agent
loop with a real (mock) model that actually obeys the injected instruction —
because a test where the model politely refuses proves the model was well
behaved, not that the architecture holds.

## 8. Security notes

| Threat | Control |
|---|---|
| Agent pays without authorization | `POST /v1/payments` requires a voucher |
| Agent forges a voucher | HMAC with a secret the agent never sees |
| Agent replays a voucher | `payments.voucher_jti UNIQUE` |
| Agent alters the amount after approval | amount is inside the MAC and re-matched |
| Prompt injection | the agent's *authority* is bounded, not its obedience |
| Agent calls a tool it was not granted | not offered, and refused if called |
| Forged webhook | HMAC over the raw body |
| Replayed webhook | idempotent on the provider's event id |
| Provider outage | payment fails; **no** payment is ever recorded as captured on a timeout |
| Cart tampering between authorize and pay | the authorized amount is what the voucher permits |

## 9. What happens at scale

The payment path adds one row and one audit event per payment; the audit chain's
per-chain advisory lock is the first thing that would bind, and per-merchant
chains are the answer (`chain_id` exists).

Webhooks arrive in bursts after settlement windows. The handler must stay
cheap and idempotent; the next step is a queue with the HTTP handler doing
nothing but verify-and-enqueue.

The agent runtime is the expensive part — an LLM call is 100–1000× the latency
of everything else here. It is deliberately *outside* the trust boundary, so it
scales separately and its failures degrade nothing inside.

---

## 10. What I learned

_(after the phase)_

## 11. Mistakes made & why

_(after the phase)_

## 12. Open questions / debt

_(after the phase)_
