# API Reference

Base URL (development): `http://127.0.0.1:8080`

> **Authentication is provisional.** Mutating endpoints require a shared
> `x-atl-admin-key` header. That is a placeholder so we never ship
> unauthenticated mandate-mutation endpoints — **not** the real model. Phase 5
> replaces it with per-agent Ed25519 request signatures; Phase 9 adds user
> sessions with RBAC. Read endpoints are currently open and must not stay that
> way.

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
| 401 | `unauthorized` | Missing or wrong `x-atl-admin-key`. Missing and wrong are indistinguishable on purpose. |
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
