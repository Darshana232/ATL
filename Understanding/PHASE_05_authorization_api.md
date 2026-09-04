# Phase 5 — The Authorization API

**Status:** DONE · **Started:** 2026-09-05 · **Finished:** 2026-09-05
**Result:** 13 rules, signed requests, single-use vouchers, 448 tests total,
no new migration.

> Sections 1–9 before any code. Sections 10–12 after.

---

## 1. What we are building

`POST /v1/authorize` — **the only door into the policy engine**, and the first
endpoint in this project with real authentication.

An agent signs a request with its Ed25519 private key. We verify it against the
public key registered in `agent_credentials`, load the mandate, compute what has
already been spent **under a row lock**, call `evaluate()`, write the request,
the decision and every rule evaluation into the audit trail in one transaction,
and — only on PASS or FLAG — mint a **single-use, 60-second, signed voucher**.

That voucher is the point of the whole project. From Phase 7, the payment
service will refuse to capture money without one. This is the phase where *"the
LLM cannot pay"* stops being a diagram and becomes a token that either exists or
does not.

## 2. Why now

Phase 4 built a pure function that decides. It has no way to be called, no way
to know who is calling, and it trusts a spend snapshot somebody hands it.

Phase 5 supplies all three: an identity, a trustworthy snapshot, and an HTTP
contract. Phase 6 (the hash-chained audit trail and `/verify`) needs real
decisions to verify. Phase 7 (payments) needs real vouchers to redeem. Both are
blocked on this.

It also retires the placeholder: `x-atl-admin-key` records a *claim* about who
acted. After this phase, an authorization request records a *verified* identity.

## 3. How it works

```
   Agent                                    ATL-India API
     │
     │  POST /v1/authorize
     │  X-ATL-Key: akid_grocery_shopper_v1
     │  X-ATL-Timestamp: 2026-09-05T14:22:03Z
     │  X-ATL-Idempotency-Key: ord_7f3a91c4
     │  X-ATL-Signature: base64(ed25519(canonical string))
     │  { mandateId, merchantId, amountPaise, paymentMethod, cart, userIntent }
     ├──────────────────────────────────────────────►
     │
     │   ┌─ 1. AUTHENTICATE ─────────────────────────────────────────┐
     │   │  look up key_id -> active credential -> public key        │
     │   │  rebuild the canonical string from what we RECEIVED       │
     │   │  verify Ed25519 signature                                 │
     │   │  reject if the timestamp is outside ±5 minutes            │
     │   │  failure -> 401, and the attempt is RECORDED              │
     │   └───────────────────────────────────────────────────────────┘
     │   ┌─ 2. IDEMPOTENCY ──────────────────────────────────────────┐
     │   │  seen (agent_id, idempotency_key) before?                 │
     │   │  yes -> return the ORIGINAL decision. Do not re-evaluate. │
     │   └───────────────────────────────────────────────────────────┘
     │   ┌─ 3. ONE TRANSACTION ──────────────────────────────────────┐
     │   │  SELECT ... FROM mandates WHERE id=$1 FOR UPDATE          │
     │   │      ↑ serialises concurrent authorizations for this      │
     │   │        mandate. Without it, two requests both see the     │
     │   │        same headroom and both pass.                       │
     │   │  load mandate + version in force  (JOIN LATERAL, Phase 3) │
     │   │  compute spend snapshot from captured payments            │
     │   │  ask the mock risk provider (in-process, advisory)        │
     │   │                                                           │
     │   │  decision = evaluate({ ..., now, spend, risk })   ← PURE  │
     │   │                                                           │
     │   │  INSERT authorization_requests                            │
     │   │  INSERT decisions                                         │
     │   │  INSERT rule_evaluations   (all 13, including passes)     │
     │   │  INSERT risk_signals                                      │
     │   │  appendAuditEvent(...)     (hash chain, Phase 3)          │
     │   └───────────────────────────────────────────────────────────┘
     │   ┌─ 4. VOUCHER — only on PASS or FLAG ───────────────────────┐
     │   │  HMAC-SHA256 over {jti, decisionId, mandateId,            │
     │   │   merchantId, amountPaise, exp}                           │
     │   │  BLOCK -> voucher is null. There is nothing to spend.     │
     │   └───────────────────────────────────────────────────────────┘
     ◄──────────────────────────────────────────────┤
        200 { verdict, reason, decisionId, evaluations[13], voucher }
```

**The response shape is a security control, not just JSON.** A BLOCK returns
`voucher: null`. A client that ignores `verdict` entirely still cannot pay,
because there is no token to present. The safety does not depend on the caller
reading the answer correctly.

## 4. Concepts I need first

**Signing is not encrypting.** A signature does not hide the request — anyone
can read it. It proves two things: the body was not altered, and it was produced
by someone holding the private key. Confidentiality is TLS's job; integrity and
authenticity are the signature's.

**Asymmetric vs symmetric — pick by asking who needs to verify.**

| | Who holds what | Why we chose it |
|---|---|---|
| **Agent → us** | agent holds the private key; we store only the public key | Ed25519. A breach of our database cannot forge requests, because there is no secret in it to steal. |
| **Us → us (voucher)** | we mint it and we verify it | HMAC-SHA256. One party on both ends, so a shared secret is simplest and fastest. Asymmetric would buy nothing. |

**The canonical signing string.** Both sides must build the *same* bytes or
every signature fails. We sign a fixed, ordered, newline-joined string:

```
ATL-v1
POST
/v1/authorize
2026-09-05T14:22:03Z
akid_grocery_shopper_v1
ord_7f3a91c4
9f2b...  ← SHA-256 of the raw request body
```

The **body is hashed, not signed directly**, so the signing string stays a fixed
short size regardless of cart size, and so we can verify before parsing JSON —
we authenticate first and interpret second. Each field is on its own line to
prevent *field-splitting ambiguity*: concatenated without separators, a
`keyId` of `"ab"` + idempotency key `"cd"` and `"a"` + `"bcd"` produce identical
bytes, so one signature would validate two different requests.

**Replay vs idempotency — the same mechanism, two different problems.**

- *Idempotency* is a friendly problem: the agent's network timed out, it retried,
  and it must not be charged twice.
- *Replay* is hostile: someone captured a valid signed request and sends it
  again.

Both are solved by the same fact — **the idempotency key is inside the signed
string**, and `UNIQUE (agent_id, idempotency_key)` already exists in migration
0004. A replay carries the same key, so it returns the original decision instead
of producing a new one. A *modified* replay breaks the signature. **We need no
nonce table**; the idempotency constraint is the nonce store.

The timestamp window (±5 minutes) bounds how long a captured request stays
usable at all, which is what keeps the set of keys we must remember finite.

**Capability token.** The voucher is not an identity token ("I am agent X"); it
is a capability ("the bearer may capture ₹1,240 at mer_bigbasket, once, before
14:23:03"). It names exactly one action. Even a fully compromised agent holding
one can only do the single thing the engine already approved.

**TOCTOU — time of check to time of use.** Between reading "₹3,100 spent" and
writing the decision, another request can spend more. Two concurrent requests
for ₹1,000 against ₹500 of remaining headroom both read ₹3,100, both compute
"fits", and both pass. `SELECT ... FOR UPDATE` on the mandate row makes the
second wait for the first to commit. **This is the debt PHASE_04 §12 recorded**,
and paying it is what turns the window limit from arithmetic into enforcement.

## 5. Design choices & tradeoffs

**1 — The agent identity check is a policy RULE, not an API 403.**
An agent presenting a mandate that belongs to a different agent is a policy
question ("was this permitted by this mandate?"), so it becomes rule
`MANDATE_AGENT_MATCH` and `ENGINE_VERSION` goes to `engine-v2`.
*Rejected:* a 403 at the route. It would be simpler, but the attempt would leave
no rule evaluation and no decision — and an agent probing other people's
mandates is precisely the pattern a security review wants to *count*. This is
also the first real exercise of `engineVersion`: decisions made yesterday
remain explainable against `engine-v1`.

**2 — A failed signature is recorded, but only when the key resolves.**
`authorization_requests.signature_verified` is a column specifically so bad
attempts are countable. But `agent_id` is a foreign key. If the `X-ATL-Key`
header names a credential that does not exist, we have no trustworthy agent id
— inserting an attacker-chosen one would let anyone write rows attributed to any
agent. So: **known key + bad signature → a recorded row; unknown key → a log
line and a 401, no row.** The honest limit of the evidence, stated rather than
papered over.

**3 — BLOCK returns HTTP 200.**
The decision is the resource, and producing it succeeded. 401/400/404/409 mean
*we could not decide*; 200 means *we decided*, and the verdict is in the body.
*Tradeoff:* several payment APIs use 402 or 403 for a denial, and a careless
client could read 200 as "paid". We accept that because the real control is
structural — a BLOCK carries no voucher — and because a status code cannot
carry a thirteen-rule breakdown.

**4 — The voucher is stateless; single use is a database constraint.**
No `vouchers` table. The token carries its own claims and its own MAC. Its
single-use property is enforced at redemption by `payments.voucher_jti UNIQUE`,
with `payments.decision_id UNIQUE` as an independent second cap.
*Rejected:* a table of issued vouchers with a `redeemed` flag — that is an
application-level check-then-write, and it loses the race that a unique index
wins. Enforcement belongs where it cannot be bypassed.

**5 — Row lock, not SERIALIZABLE.**
`FOR UPDATE` on the mandate row is a lock on the exact object being contended,
it is understandable by a first-year reader, and it needs no retry loop.
*Rejected:* `SERIALIZABLE` isolation, which pushes conflicts to commit time as
40001 errors and requires every caller to implement retry — and retry loops are
where concurrency bugs live. *Rejected:* an advisory lock, which would work, but
the mandate row already exists and is guaranteed by a foreign key.

**6 — The risk provider stays in-process.**
`MockRiskProvider` is deterministic and makes no network call, so the
authorization path has **no third-party dependency** (ADR-0013's hot-path
prohibition). When a real provider arrives it goes behind the same interface
with a timeout and degrades to `risk: null` — never to a block.

**7 — Phase 5 adds no migration.**
Every column it needs — `credential_id`, `signature_verified`, `idempotency_key`,
`request_id`, `voucher_jti` — was designed in Phase 2, before there was any code
to use them. That is the payoff for writing the schema deliberately instead of
letting an ORM infer it.

### Where the LLM is, in this phase

Still nowhere. The agent runtime that *calls* this endpoint will contain a
language model (Phase 7), but it lives on the other side of the trust boundary,
and everything it sends is a **proposal**. Nothing on this side of the network
hop imports an AI SDK.

## 6. Files created/modified

```
apps/api/src/
  policy/rules.ts            + MANDATE_AGENT_MATCH; ENGINE_VERSION -> engine-v2
  policy/types.ts            + attempt.agentId
  auth/signing.ts            canonical signing string + Ed25519 verify
  auth/signing.test.ts
  middleware/agent-auth.ts   preHandler: key lookup, freshness, verification
  middleware/agent-auth.test.ts
  voucher/voucher.ts         mint / verify, HMAC-SHA256, jti, 60s TTL
  voucher/voucher.test.ts
  repositories/spend.ts      spend snapshot under FOR UPDATE
  repositories/spend.test.ts
  repositories/authorization.ts  request, decision, rule rows, risk row
  providers/risk.ts          RiskProvider interface + MockRiskProvider
  dto/authorization.ts       Zod strictObject wire schemas
  routes/authorize.ts        POST /v1/authorize
  routes/authorize.test.ts
  server.ts                  register the route
docs/DECISIONS.md            + ADR-0015 (credentials) — see §12
```

## 7. How we test it

The rule from `CLAUDE.md` §4 applies with full force here: **prove the claimed
properties, do not assert them.** Every security claim gets a test that fails
when the claim stops being true.

| Claim | The test that would fail |
|---|---|
| A tampered body is rejected | sign a valid request, change `amountPaise` by 1 paisa, expect 401 |
| Another agent's key cannot be used | sign with agent B's key, present agent A's `key_id` |
| A stale request is rejected | timestamp 6 minutes old, expect 401 |
| A replay is not a second charge | send the identical request twice, expect one decision id and one row |
| A revoked credential cannot authenticate | set `status='revoked'`, expect 401 |
| BLOCK mints no voucher | assert `voucher === null` on every blocking scenario |
| A voucher cannot be edited | flip one character of the amount claim, expect verification failure |
| An expired voucher is refused | mint with `exp` in the past |
| The row lock actually serialises | two concurrent requests against ₹500 of headroom → exactly one PASS |
| Failures leak nothing | assert no stack trace, SQL or key material in any 4xx/5xx body |

The concurrency test is the one that matters most and the one most likely to
pass for the wrong reason. It needs **two real connections** and a barrier that
forces genuine overlap — if they run sequentially it passes while proving
nothing. **Positive control** (the Phase 4 lesson): run the same test with the
lock removed and confirm it *fails*. A test that cannot fail is not evidence.

## 8. Security notes

| Threat | Control | Layer |
|---|---|---|
| Forged request | Ed25519 over a canonical string | signature |
| Stolen database → forged requests | we store only public keys | schema |
| Body tampering | body SHA-256 inside the signed string | signature |
| Replay | timestamp window + `UNIQUE (agent_id, idempotency_key)` | database |
| Double charge on retry | same constraint; replay returns the original decision | database |
| Concurrent limit evasion | `SELECT … FOR UPDATE` on the mandate row | database |
| Agent using another's mandate | `MANDATE_AGENT_MATCH` rule | policy engine |
| Voucher forgery | HMAC-SHA256 with `VOUCHER_SIGNING_SECRET` | crypto |
| Voucher reuse | `payments.voucher_jti UNIQUE` | database |
| Voucher for a different payment | amount + merchant are inside the MAC | crypto |
| Timing attacks on comparison | `timingSafeEqual` over equal-length digests | code |
| Information disclosure | 401 does not distinguish missing / malformed / wrong | code |

**What this does NOT protect against, stated plainly.** An attacker who steals
an agent's *private key* becomes that agent — but they are still confined to
that agent's mandates and every limit in them, which is the entire argument for
mandates. Someone with database superuser rights can rewrite anything; our
ceiling remains **tamper-evident**, never tamper-proof.

## 9. What happens at scale

The row lock is the bottleneck by design: authorizations for **one mandate**
serialise. Different mandates never contend, so throughput scales with the
number of distinct mandates, not with total traffic. For a consumer mandate —
a handful of payments a day — this is free.

If one mandate ever became hot, the order is: measure first, then a per-mandate
rollup counter maintained in the same transaction (removing the sum over
payments), then partitioning the spend table by time. A cache comes last and
probably never, because a cache is a second source of truth for a *security*
limit — the same trade we rejected for Redis in ADR-0005.

`EXPLAIN ANALYZE` on the spend query and on `loadForAuthorization` is owed from
Phase 2 and lands in this phase.

---

## 10. What I learned

**Pick asymmetric vs symmetric by asking who needs to verify.** This is the one
sentence worth keeping from the whole phase. Agent → us has two parties and one
must not be able to impersonate the other, so it is Ed25519 and we store only
public keys. The voucher is minted and verified by the same party, so it is
HMAC. The question answers itself once it is asked in that form; before that,
"use the strong one" felt like the safe default and would have been wasted
complexity in one direction and a security hole in the other.

**A signature is not a replay defence.** I expected signing to solve replay, and
it does not — a captured request stays valid forever. What actually stops it is
*remembering* what you have already seen. The good news was that we already had
the memory: `UNIQUE (agent_id, idempotency_key)` from Phase 2. Putting the
idempotency key *inside* the signed string turned an idempotency mechanism into
a nonce store for free, and the timestamp window is what keeps the set of keys
we would have to remember finite rather than infinite.

**Authenticate first, interpret second.** Hashing the raw body rather than
signing a parsed object is not just about determinism (though re-serialising
JSON does change the bytes — key order, whitespace, number formatting). It means
untrusted input never reaches the JSON parser on an unauthenticated request, and
a parser is a far larger attack surface than a hash. The same ordering shows up
inside `verifyVoucher`: check the MAC *before* reading `exp`, because reading a
claim out of an unverified token is trusting attacker-controlled JSON.

**Time-of-check to time-of-use is not a bug in either check.** Two concurrent
₹400 requests against ₹500 of headroom each evaluate *correctly*. The engine is
right both times. The defect is that the two evaluations were allowed to
overlap. That reframing is why the fix is a lock and not a smarter rule — and it
is why PHASE_04 could be genuinely correct and still leave the limit
unenforceable.

**Deriving the voucher id from the decision id closed a hole I had not seen.**
My first instinct was a random `jti`. Then a replay would mint a *second*
spendable token for the same decision, and `payments.voucher_jti UNIQUE` would
happily accept both. Deriving it means every voucher for a decision shares one
id, so the database caps the decision at one payment however many times it is
retried — and `payments.decision_id UNIQUE` caps it again, independently.

**Timezone arithmetic has no API and two traps.** A spending "day" is the user's
day, so a weekly limit for someone in Asia/Kolkata resets at 18:30 UTC. There is
no direct way to ask JavaScript for a zone's offset; you format an instant in
the zone, read the wall-clock fields back and interpret them as UTC. And
`getDay()` calls Sunday 0 — the US convention — which would put Sunday's
spending in the following week. Both are written down in `spend.ts` because both
are the kind of thing that looks right until a Sunday in October.

**Structural safety beats a status code.** The strongest argument for returning
200 on BLOCK was not an HTTP-semantics argument at all. It was noticing that the
response carries no voucher, so a client that ignores the verdict *still cannot
pay*. Safety that does not depend on the caller reading the answer correctly is
the only kind worth relying on.

## 11. Mistakes made & why

**1. A test that passed while executing nothing — again.** I wrote an HTTP-level
test for duplicate headers ("two `X-ATL-Signature` headers must be rejected").
It passed. It was worthless: Fastify's `inject` collapses repeated headers
before the handler sees them, so the `string[]` branch never ran. The test
asserted 401 and got 401 for a completely unrelated reason.

This is PHASE_04's mistake in new clothing — a green result that measured
nothing — and the fix was the same shape as the fix there: move the check to
where it can actually be observed. `singleHeader` is now exported and tested
directly, and the file's header comment says why, so nobody "helpfully" moves it
back to an HTTP test later. **Ask what would have to be broken for this test to
fail. If the answer is "nothing", it is not a test.**

**2. I wrote unreadable index arithmetic and shipped it for four minutes.**
Building a thirteen-row multi-row INSERT, my first attempt computed placeholder
offsets with a helper called `tupleOffset` that returned 0, plus a discarded
`tuples` array. It type-checked. It would probably even have worked. It was
incomprehensible, and in a file that builds SQL, incomprehensible is dangerous —
that is precisely where an injection bug hides. Rewritten with a named
`COLUMNS_PER_ROW` and a generated placeholder list. **In SQL-building code,
"clever" is a smell, not a compliment.**

**3. `mkdir apps/api/src/auth` created `apps/api/apps/api/src/auth`.** The shell
had kept its working directory from a previous `cd apps/api`. TypeScript caught
it immediately — `Cannot find module '../auth/signing.js'` — which is exactly
what a compiler is for, but it cost a confusing minute. **A shell's working
directory persists; absolute paths do not care.**

**4. The demo blocked every scenario on TIME_WINDOW.** I ran it at 04:55 IST
against a mandate permitting 08:00–20:00. Every scenario blocked on rule 9 and
the demo showed nothing else. The fix was to pin the demo clock and *say on
screen that it is pinned* — using the same injected clock the engine already
takes. A hidden pin would have been dishonest; a labelled one is reproducible.
**When something must be simplified for a demo, label it in the demo output, not
in a footnote nobody reads.**

**5. I nearly recorded rejected signatures in the wrong table.**
`authorization_requests.signature_verified` was designed in Phase 2 for exactly
this. But that row has NOT NULL foreign keys to a mandate, a mandate *version*
and a merchant — and a request whose signature failed may contain nothing valid
at all. Writing it would mean inserting attacker-chosen identifiers or failing
on a foreign key, and neither is evidence. Rejections go to the audit chain,
which has no such constraints. **A column existing is not proof that it can be
populated; check the constraints on the row it lives in.**

## 12. Open questions / debt

- **`signature_verified` can only ever be `true`.** Given the foreign keys on
  `authorization_requests`, a failed-signature attempt cannot form a valid row,
  so rejections live in `audit_events` instead. A future migration should either
  relax those keys, add a dedicated `rejected_auth_attempts` table, or drop the
  column. Documented rather than quietly ignored.
- **The freshness window does not survive a restart.** Replay protection relies
  on `UNIQUE (agent_id, idempotency_key)`, which is durable — but nothing prunes
  old keys. At scale that table grows forever; it needs time-partitioning and a
  retention policy, which is Phase 9 work.
- **`ENGINE_VERSION` still has to be bumped by hand.** Carried over from
  PHASE_04 §12, and this phase proved it matters: adding rule 13 required
  remembering. A test comparing a hash of the rule set would force it.
- **No rate limiting yet.** A valid credential can currently make unlimited
  requests. Every one takes a row lock on its mandate, so an agent can degrade
  *its own* throughput but not anyone else's — bounded, but still Phase 9 work.
- **The voucher is not bound to a payment provider or an idempotency key.** A
  voucher names a mandate, a merchant and an amount. Phase 7 should decide
  whether it must also name the payment attempt.
- **`EXPLAIN ANALYZE` is still owed** on `loadForAuthorization` and the spend
  query, with real row counts. Carried from Phase 2, now with a hot path that
  actually runs on every request.
- **The MockRiskProvider's heuristics are invented.** They are labelled as
  simulation everywhere they surface, and they exist to make the FLAG path
  demonstrable. They are not a fraud model and must never be described as one.
