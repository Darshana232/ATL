# API Reference

Base URL (development): `http://127.0.0.1:8080`

> **Two authentication models, on purpose.**
>
> `POST /v1/authorize` uses the real one: **per-agent Ed25519 request
> signatures** (ADR-0015). Mandate *mutation* endpoints still use the shared
> `x-atl-admin-key` placeholder — a mandate is created by a human, not an
> agent, so it needs user sessions with RBAC rather than agent signatures.
> That arrives in Phase 9. Read endpoints are currently open and must not stay
> that way.

## Conventions

| Rule | Detail |
|---|---|
| **Money** | Integer **paise**, field names end `Paise`. `200000` = ₹2,000. Matches Razorpay's own API. No formatted string is ever returned — formatting is locale-dependent presentation. |
| **Time** | Full ISO-8601 instants (`2026-09-01T00:00:00Z`). A bare date is rejected: it does not say which moment it means. |
| **Unknown fields** | **Rejected**, never ignored. A typo like `perTxnLimitPais` returns 400 rather than silently dropping a limit you thought you set. |
| **Errors** | Every problem is reported at once, each naming its field. |
| **Request IDs** | Send `x-request-id` to have it propagated; otherwise one is generated and returned on errors. |

## Error shape

```json
{
  "error": "validation_failed",
  "message": "Request body is invalid.",
  "issues": [
    { "field": "terms.perTxnLimitPaise", "message": "must not exceed terms.windowLimitPaise" }
  ]
}
```

| Status | `error` | Meaning |
|---|---|---|
| 400 | `validation_failed` | Shape, format or semantic problem. `issues` names each field. |
| 401 | `unauthorized` | Missing or invalid credentials. Every cause — missing header, unknown key, revoked credential, suspended agent, stale timestamp, bad signature — returns the **same** body, so probing cannot map our state. |
| 404 | `not_found` | No such mandate or version. |
| 409 | `mandate_revoked` | Revocation is terminal; a revoked mandate cannot gain new terms. |
| 409 | `already_revoked` | Already revoked. |
| 409 | `conflict` | Uniqueness violation. |
| 500 | `internal_error` | Our bug. Opaque by design; quote the `requestId`. |

---

## `POST /v1/mandates` — create a mandate

Creates the mandate **and its version 1** in one transaction, together with a
hash-chained `MANDATE_CREATED` audit event.

**Headers:** `x-atl-admin-key`

```json
{
  "userId": "usr_ananya",
  "agentId": "agt_grocery_shopper",
  "label": "Weekly groceries",
  "terms": {
    "perTxnLimitPaise": 200000,
    "windowLimitPaise": 500000,
    "windowKind": "week",
    "maxTxnPerHour": 5,
    "blockedMccs": ["5921", "7995"],
    "timezone": "Asia/Kolkata",
    "windowStartHour": 8,
    "windowEndHour": 20,
    "allowedWeekdays": ["MON","TUE","WED","THU","FRI","SAT"],
    "validFrom": "2026-09-01T00:00:00Z",
    "validTo": "2026-12-31T23:59:59Z",
    "paymentMethods": ["upi_reserve_pay"]
  },
  "merchantIds": ["mer_bigbasket", "mer_zepto"],
  "consentRef": "consent_abc_001",
  "consentAt": "2026-09-01T08:55:00Z",
  "createdBy": "admin",
  "ifsc": "HDFC0000001"
}
```

| Field | Notes |
|---|---|
| `merchantIds` | **Required.** An empty array means **no merchant is permitted** — deny by default. It must stay distinguishable from "not provided". |
| `consentRef`, `consentAt` | **Required on every version, including the first.** The database enforces it (`NOT NULL`). `consentAt` must not be later than the moment the version is created. |
| `blockedMccs` | ISO 18245 codes. Category rules key on MCC, not product names — a four-digit code assigned to the merchant is far harder to game. |
| `timezone` | The time window is expressed in **this** zone, not UTC. Validated against real IANA zones. |
| `ifsc` | Optional. Triggers a **cold-path** lookup against Razorpay's public IFSC API. Never called during authorization (ADR-0013). |

**201 Created**

```json
{
  "mandate": { "id": "mnd_…", "status": "active", "currentVersion": { "version": 1, "…": "…" } },
  "bankContext": { "ifsc": "HDFC0000001", "bank": "HDFC Bank", "supportsUpi": true },
  "warnings": []
}
```

`bankContext` is `null` when no IFSC was supplied, the code was unknown, or the
lookup was unavailable. **A failed lookup never fails the request** — a
compliance system must not be unable to create a mandate because a third party
is slow. The degradation is recorded in the audit payload rather than hidden,
and surfaces in `warnings`.

---

## `GET /v1/mandates/:id`

**200** → `{ "mandate": { …, "currentVersion": { … } } }` · **404** if unknown.

## `GET /v1/mandates/:id/versions`

**200** → `{ "versions": [ … ] }`, oldest first.

## `GET /v1/mandates/:id/versions/:version`

**The read the whole design exists for.** A decision made under version 1 stays
explainable against version 1's numbers, forever — even after version 3 raised
the limit. Versions are immutable; nothing can rewrite them.

**200** → `{ "version": { … } }` · **400** if `:version` is not a positive
integer · **404** if that version does not exist.

## `POST /v1/mandates/:id/versions` — supersede the terms

**Headers:** `x-atl-admin-key`. Body is the create body minus
`userId`/`agentId`/`label`/`ifsc`.

Never updates the existing version — it appends a new one and writes a
`MANDATE_VERSION_ADDED` audit event in the same transaction.

**201** → `{ "version": { "version": 2, … } }` · **409 `mandate_revoked`** if
the mandate is revoked (revocation is terminal — issue a new mandate instead).

## `POST /v1/mandates/:id/revoke`

**Headers:** `x-atl-admin-key`

```json
{ "revokedBy": "usr_ananya", "revokedReason": "user withdrew consent" }
```

`revokedReason` is **required** — a revocation with no reason is exactly what a
dispute or an audit will ask about.

**200** → the revoked mandate · **409 `already_revoked`** on a repeat. A repeat
writes **no** audit event: a trail full of no-op "revoked" entries would
misrepresent what happened.

---

## Audit events

Every mutation writes one hash-chained event in the **same transaction** as the
data, so the trail can never disagree with the database.

| Event | Written when |
|---|---|
| `MANDATE_CREATED` | a mandate and its version 1 are created |
| `MANDATE_VERSION_ADDED` | terms are superseded |
| `MANDATE_REVOKED` | a mandate is actually revoked (not on a repeat) |

Payloads are built from an **explicit allowlist** of fields, never by spreading
the request — an allowlist fails closed, so a field added to the API later stays
out of the hashed trail until someone puts it there deliberately.

The hash covers the whole logical record (actor, subject, timestamps, payload
hash and predecessor hash), so altering any of them breaks every hash after it.
Verification, signed checkpoints and the tamper demonstration arrive in Phase 6.

## Health

| Endpoint | Purpose |
|---|---|
| `GET /v1/health/live` | Liveness. Touches nothing. Failing means **restart me**. |
| `GET /v1/health` | Readiness. Queries Postgres. **503** when degraded — meaning *stop sending traffic*, not *restart me*. |


---

## `POST /v1/authorize` — request payment authorization

**The only door into the policy engine**, and the endpoint that mints the
voucher a payment cannot happen without.

### Authentication: Ed25519 request signatures

| Header | Example | Notes |
|---|---|---|
| `X-ATL-Key` | `akid_grocery_shopper_v1` | Public key id. Not a secret; it only says which public key to verify against. |
| `X-ATL-Timestamp` | `2026-09-07T08:52:00.000Z` | Must be within **±5 minutes** of our clock, in either direction. |
| `X-ATL-Idempotency-Key` | `ord_7f3a91c4` | 8–255 chars. **Also the replay nonce** — see below. |
| `X-ATL-Signature` | base64 | Ed25519 over the canonical signing string. |

**The canonical signing string** — build these seven lines, joined with `\n`:

```
ATL-v1
POST
/v1/authorize
2026-09-07T08:52:00.000Z
akid_grocery_shopper_v1
ord_7f3a91c4
9f2b1c…                      ← lowercase hex SHA-256 of the RAW request body
```

Sign those bytes with your Ed25519 private key and base64 the 64-byte result.

Why this shape: the **body is hashed, not signed directly**, so the string stays
a fixed small size and can be verified before any JSON is parsed. **One field
per line** removes field-splitting ambiguity — concatenated, `keyId` `"ab"` plus
key `"cd"` and `"a"` plus `"bcd"` would be the same bytes and one signature
would validate two different requests. Header values must therefore be
printable, single-line ASCII, at most 255 characters.

### Idempotency and replay — one mechanism

The idempotency key is *inside* the signed string and is unique per agent in the
database. So:

- A **retry** after a timeout returns the original decision. No second charge.
- A **replay** by an attacker carries the same key and gets the same decision
  back. It cannot produce a new one, and it cannot mint a second spendable
  voucher, because the voucher id is derived from the decision id.
- A **modified** replay breaks the signature.

Replayed responses set `idempotentReplay: true`. Two agents may safely choose
the same key — idempotency is scoped per agent.

### Request

```json
{
  "mandateId": "mnd_weekly_groceries",
  "merchantId": "mer_bigbasket",
  "amountPaise": 124000,
  "paymentMethod": "upi_reserve_pay",
  "userIntent": "Order this week's groceries",
  "cart": [
    { "sku": "atta-5kg", "name": "Whole wheat atta 5kg", "quantity": 1, "unitPricePaise": 32500 }
  ]
}
```

`cart` (≤100 lines) and `userIntent` (≤2000 chars) are optional. **There is no
`agentId` field** — the agent is established by the signature, never claimed by
the body.

### Response — 200 for every verdict

```json
{
  "decisionId": "dec_52ea22f8d010463bed87",
  "authorizationRequestId": "authz_9c1f…",
  "verdict": "PASS",
  "reason": "Authorized: all 13 applicable policy checks passed.",
  "engineVersion": "engine-v2",
  "mandateId": "mnd_weekly_groceries",
  "mandateVersion": 1,
  "evaluatedAt": "2026-09-07T08:52:00.000Z",
  "evaluations": [
    {
      "ruleCode": "MANDATE_PER_TXN_LIMIT",
      "sequence": 5,
      "verdict": "PASS",
      "signal": "requested 124000 paise",
      "expected": "<= 200000 paise",
      "actual": "124000 paise",
      "reason": "₹1,240.00 is within the ₹2,000.00 per-transaction limit.",
      "observedPaise": 124000,
      "limitPaise": 200000
    }
  ],
  "voucher": {
    "token": "atlv1.eyJqdGki….signature",
    "jti": "76ed7034a2b65a8de8b3136c508a7dbb",
    "expiresAt": "2026-09-07T08:53:00.000Z"
  },
  "risk": { "provider": "mock", "score": 7, "band": "LOW" },
  "simulation": "SIMULATED MANDATE RAIL. …",
  "idempotentReplay": false
}
```

**`BLOCK` also returns 200** (ADR-0016). The decision is the resource and
producing it succeeded; the verdict is the answer, not an error. The safety is
structural rather than conventional:

> **On `BLOCK`, `voucher` is `null`.** A client that ignores `verdict` entirely
> still cannot pay, because there is no token to present.

`evaluations` always contains **all 13 rules**, including the ones that passed
and the ones that were `SKIP`ped. Recording only failures would leave us unable
to prove a check was performed — and "did you check the merchant?" is exactly
what an auditor asks.

### The voucher

A single-use, 60-second **capability token**: not "I am agent X" but "the bearer
may capture ₹1,240 at `mer_bigbasket`, once, before 08:53:00". Every constraint
the engine checked is inside the MAC, so editing the amount, the merchant or the
expiry invalidates it.

Single use is not a property of the token — it is enforced at redemption by
`payments.voucher_jti UNIQUE`, because an application-level "have we seen this
id?" loses the race a unique index wins.

### Status codes

| Status | `error` | Meaning |
|---|---|---|
| 200 | — | A decision was made. Read `verdict`. |
| 400 | `validation_failed` | Malformed body, unknown field, bad amount. |
| 401 | `unauthorized` | Signature, key, credential, agent status or timestamp problem. One message for all of them. |
| 404 | `mandate_not_found` / `merchant_not_found` | Unknown identifier. |
| 500 | `internal_error` | Our bug. Opaque; quote the `requestId`. |

### Try it

```
npm run seed                       # writes .seed-keys.json (gitignored)
npm run demo:authorize -w apps/api # real socket, real signatures, 7 scenarios
```

---

## Audit endpoints

All three require `x-atl-admin-key`. The trail contains merchant names, amounts,
mandate ids and — in `user_intent` — personal data, so none of them is open.

### `GET /v1/audit/verify`

Walks the chain, recomputes every hash, and reports the first place the record
and the computation disagree.

```json
{
  "chainId": "main",
  "status": "intact",
  "eventsChecked": 1490,
  "totalEvents": 1490,
  "firstBreak": null,
  "headHash": "35a71c08864a7db5…",
  "checkpoints": [
    { "id": "ckpt_…", "seq": 1490, "status": "valid", "detail": "Anchor signature and head hash both match." }
  ],
  "durationMs": 41,
  "limitation": "TAMPER-EVIDENT, NOT TAMPER-PROOF. …"
}
```

On damage:

```json
{
  "status": "broken",
  "eventsChecked": 1,
  "totalEvents": 5,
  "firstBreak": {
    "seq": 1487,
    "eventId": "evt_816a17b9ddd6ee4a3d37512f",
    "kind": "event_hash_mismatch",
    "detail": "A hashed field of this event was altered. The hash covers the WHOLE record…"
  }
}
```

**`kind`** is one of `payload_hash_mismatch` (the payload was edited),
`event_hash_mismatch` (any hashed field — actor, timestamp, event type),
`broken_link` (an earlier event was edited-and-rehashed, or removed),
`unexpected_genesis`, `missing_genesis`.

**Only the first break is reported.** After one broken link every later row also
fails; listing them all would return a million lines describing one edit.
`eventsChecked` says how far the chain was sound.

**200 for both outcomes** — the verification ran and produced an answer. Same
reasoning as ADR-0016.

> **`limitation` is present on every response, including successful ones.** A
> hash chain *detects* modification; it does not prevent it. Do not present a
> green result as "tamper-proof".

### `POST /v1/audit/checkpoint`

Anchors the current head with an HMAC signature, so a later *consistent
full-chain rewrite* becomes detectable.

```json
{ "chainId": "main", "createdBy": "compliance@example.com" }
```

`201` with the signed facts. Errors: `409 chain_broken` (the chain does not
currently verify — anchoring it would certify the damage), `409 chain_empty`,
`409 checkpoint_exists`, `503 checkpoints_unavailable` (no signing secret
configured — we fail closed rather than issue a forgeable anchor).

### `GET /v1/audit/events`

Newest first, keyset-paginated. Query: `chainId`, `mandateId`, `eventType`,
`beforeSeq`, `limit` (capped at 200). Every event is returned with its
`payloadHash`, `prevHash` and `hash`, so a third party can recompute the chain
without trusting our verifier.

Pagination is **keyset** (`beforeSeq`), not `OFFSET`: this table is append-only,
so rows arriving mid-pagination would make offsets skip and repeat.

### Try it

```
npm run demo:tamper -w apps/api
```

Writes five real events, verifies, anchors them, shows the application role
*and* the database owner both being refused, then disables the append-only
trigger as a privileged insider would, edits one event's **actor**, and shows
verification failing and naming the row.

---

## `POST /v1/payments` — redeem a voucher

Signed like every agent endpoint (see `/v1/authorize`). **There is no path
through this endpoint to a payment provider without a valid, unexpired, unspent
voucher.**

```json
{ "voucher": "atlv1.eyJqdGki….signature", "amountPaise": 124000, "merchantId": "mer_bigbasket" }
```

`amountPaise` and `merchantId` are **cross-checked against the voucher's
claims**. They are not redundant: the voucher says what was *approved*, these
say what is being *attempted*, and requiring them to match is what makes the
token a capability for one payment rather than a bearer credential for any.

The order of checks is the security model: verify the MAC → check expiry →
match the claims to this request → cross-check the stored decision → **claim
the voucher by INSERT** (`payments.voucher_jti UNIQUE`) → only then call the
provider.

| Status | Meaning |
|---|---|
| 201 | Captured. Body carries `paymentId`, `providerPaymentId`, `simulated`. |
| 202 | Authorized, awaiting the provider's webhook to capture. |
| 200 | The provider declined. `status: "failed"` with a `failureReason`. |
| 400 | Malformed body. |
| 401 | `invalid_voucher` — missing, forged, expired or unreadable. One message for all four. |
| 409 | `voucher_mismatch` (wrong amount, merchant or agent) or `voucher_already_used`. |
| 503 | `payments_unavailable` — no signing secret configured. Fails closed. |

**A failed payment still consumes its voucher.** Otherwise a decline could be
retried indefinitely against one authorization, and each retry is a real
attempt on a real rail.

`GET /v1/payments/:id` returns the payment for reconciliation. A GET has no
body, so the body-hash line of the signing string is the hash of the empty
string, and the signed path is the route pattern `/v1/payments/:id`.

## `POST /v1/webhooks/razorpay` — provider callbacks

Authenticated by **HMAC-SHA256 over the raw body** (`x-razorpay-signature`).
This is the whole of the authentication: without it, anyone who knows the URL
can mark any payment captured.

Idempotent on `x-razorpay-event-id`, falling back to a hash of the body when the
header is absent (weaker, and recorded as `event_id_source: "body_hash"`).
Delivery is **at-least-once**, so a redelivery returns `200 { duplicate: true }`
rather than an error — an error would make the provider retry forever.

| Outcome | Meaning |
|---|---|
| `captured` / `failed` | The payment was moved to that state. |
| `duplicate` | Already in that state. |
| `unmatched` | No local payment matches the order. |
| `ignored` | An event type we do not handle. |
| `rejected` | Signature did not verify (`401`). Recorded as evidence. |

An **amount mismatch** between the provider and our authorized amount is
recorded as `failed`, never captured: it is a reconciliation incident requiring
a human.

## Agent tools

The agent runtime and the MCP server share one registry
(`apps/api/src/agent/tools.ts`) and one authorization function.

| Tool | Granted to the shopping agent |
|---|---|
| `search_products`, `get_product`, `create_cart` | yes |
| `get_mandate`, `get_transaction` | yes |
| `request_authorization`, `execute_payment` | yes |
| `modify_mandate`, `delete_audit_event`, `export_all_users`, `generate_compliance_report` | **no — granted to nobody** |

Ungranted tools are **not offered** *and* **refused if called**. Only the second
is a security control: a model can invent a tool name it was never shown.

`execute_payment` is safe to grant because it cannot move money without a
voucher. Granting it makes the agent useful; the voucher makes it safe.

### MCP

```
npm run mcp -w apps/api          # stdio MCP server
ATL_MCP_AGENT_ID=agt_grocery_shopper ATL_MCP_MANDATE_ID=mnd_weekly_groceries
```

The agent identity comes from the environment, never from a tool parameter — a
client that could choose its own agent id would be choosing its own
permissions.

### Try it

```
npm run demo:agent -w apps/api
```

Four runs: a compliant purchase, an over-limit purchase, a **prompt injection
hidden in a real seeded product listing** that the agent obeys completely and
still cannot act on, and an injection aimed at tools it was never granted.
