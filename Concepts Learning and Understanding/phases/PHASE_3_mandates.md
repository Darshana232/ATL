# Phase 3 — Mandates

**Status:** 🔄 in progress · **Commits so far:** `2fdafd3`, `c0b8f2c`,
`99a5988`, `0997978`, `e49a3f3`

---

## What it is

The code layer on top of the mandate schema, and the HTTP API for it: create a
mandate, read it, read any past version, add a version, revoke it. Plus the
first audit events and the first live external API call.

## Why it comes here

The policy engine (Phase 4) needs something authoritative to evaluate against,
and it needs to load **the exact version** a past decision used. "Authorize" is
meaningless without "the thing being authorized against".

## The steps

**1. Consent is mandatory** — `0006_consent.sql`
Every version, including v1, requires `consent_ref` and `consent_at`, both
`NOT NULL`, plus a `CHECK` that the reference isn't blank and that consent
doesn't postdate the change it authorises (with one minute of clock-skew
tolerance).

*The rejected alternative and why it matters:* gate only **widening** changes.
That needs a classifier deciding whether a diff increases authority — and that
classifier then sits **in the security path**, where a bug is a silent authority
increase. `NOT NULL` has no moving parts.

*The migration problem this created:* you cannot add a `NOT NULL` column with no
default to a table that has rows. The textbook fix is add-nullable → backfill →
set-not-null, and **step two was blocked by our own append-only trigger.** We
made that table unbackfillable on purpose, and this is the first time it bit.
`DEFAULT 'legacy'` was rejected outright — it would stamp a *fabricated* consent
reference onto historical rows, and inventing evidence is the one thing this
project must never do. Against real data the answer is nullable columns plus a
grandfather `CHECK` so old rows are *visibly* exempt. Here the only rows were
regenerable seed fixtures, so we re-migrated from empty.

**2. The domain model** — `domain/mandate.ts`
Pure: no database, no clock, no network, no logging. Time is passed *in*. That
is what lets the Phase 4 engine consume these types with no infrastructure.

- `MandateTerms` — a **value object**: immutable and known-coherent once
  constructed, so consumers never re-check it.
- `createMandateTerms()` — the only way to make one, and it reports **every**
  problem at once rather than one per round trip.
- Branded `Paise`, so a plain `number` can't be passed where money is expected.

*Why validate here when the database already does?* Three reasons, and this is
a good interview answer: (a) **useful errors** — the database says "violates
check constraint `mandate_versions_per_txn_within_window`"; the API needs to say
*which field* and why, as a 400; (b) **no database required**, so the engine is
testable in isolation; (c) **invariants SQL cannot express** — a `CHECK` cannot
tell whether `"Asia/Kolkata"` is a real IANA timezone, or spot duplicates inside
an array.
*The risk of two layers is drift*, so there are tests asserting that anything
the database refuses is refused here too.
→ 33 tests.

**3. Canonical JSON and the audit writer** — `audit/canonical.ts`, `audit/writer.ts`

`canonicalJson` sorts object keys recursively, preserves array order, and
**rejects rather than coerces** anything ambiguous. Why: `{"a":1,"b":2}` and
`{"b":2,"a":1}` are the same object but **different bytes**, and a hash is over
bytes. Hash raw `JSON.stringify` output and the chain breaks the day a library
reorders keys — and "the audit trail no longer verifies" is indistinguishable
from tampering. **A chain that cries wolf is worse than no chain.**

The writer hashes **the whole logical record**, not just the payload:

```
payload_hash = sha256(canonical(payload))
hash         = sha256(canonical({ v, chainId, id, eventType, occurredAt,
                                  actorKind, actorId, subjectKind, subjectId,
                                  requestId, mandateId, payloadHash, prevHash }))
```

Three things to notice: `prevHash` is *inside* the hash, so each row commits to
its predecessor; `chainId` is inside it, so a row can't be moved between chains;
`v` is the scheme version, so a future change is explicit and old rows stay
verifiable. And `occurredAt` is generated **in code**, not by a database
default, specifically so it *can* be hashed — a DB default would be unknown to
us at hash time and therefore unprotected.
Appending takes a `pg_advisory_xact_lock` first, because appending is inherently
serial.
→ 31 tests.

**4. Wire schemas and mappers** — `dto/mandate.ts`
The wire shape is **not** the domain shape. A clean division of labour, so the
two layers can't drift:

| Layer | Owns | Examples |
|---|---|---|
| **Zod** | shape and format | is it an integer? a valid ISO-8601 instant? does the id match `^mnd_`? |
| **Domain** | meaning | is perTxnLimit ≤ windowLimit? is the timezone real? duplicates in the array? |

Each rule lives in exactly one place; Zod deliberately does *not* re-check what
`createMandateTerms` checks. Unknown fields are rejected (`z.strictObject`).
Money on the wire is **integer paise**, matching Razorpay's own API.
→ 32 tests.

**5. The repository** — `repositories/mandate.ts`
The only module that knows SQL for mandates. Two reads that matter:

- `loadForAuthorization(id)` — mandate + **current** version + allowlist, in
  **one query**. Phase 4 calls this on every authorization, so it must not be
  N+1.
- `loadVersion(id, n)` — a *specific* historical version, for re-explaining a
  past decision. **This read is the entire reason the two-table design exists.**

Every function takes a `client`, not a pool, so the **caller controls the
transaction** — which is what lets a route write a mandate and its audit event
atomically. An audit event describing a mandate that was never created is worse
than either alone.
→ 18 tests.

**6. Admin auth (a deliberate stopgap)** — `middleware/admin-auth.ts`
A shared key in the `x-atl-admin-key` header, compared with `timingSafeEqual`
after hashing both sides (hashing guarantees equal length, because
`timingSafeEqual` *throws* on a length mismatch — which would itself leak the
key's length).
This is **not** the real model; Phase 5 replaces it with per-agent signatures.
It exists because the alternative was shipping unauthenticated
mandate-*mutation* endpoints, and normalising that default is how systems end up
exposed. **"Weak" and "absent" are different categories.**

**7. Cold-path bank lookup** — `providers/bank-lookup.ts`
The only live external call in the system, and it is confined to mandate
*creation* — never the authorization path (ADR-0013). The external response is
treated as **untrusted input** and parsed with Zod, so a third party renaming a
field produces a clear failure rather than `undefined` flowing into our
database. Three implementations behind one interface: `RazorpayIfscProvider`,
`StaticBankProvider` (tests), `FailingBankProvider` (proving graceful
degradation).

**8. Still to do:** the four HTTP routes —
`POST /v1/mandates`, `GET /v1/mandates/:id`, `POST /v1/mandates/:id/versions`,
`POST /v1/mandates/:id/revoke` — wiring all of the above together inside one
transaction per write, emitting `MANDATE_CREATED`, `MANDATE_VERSION_ADDED` and
`MANDATE_REVOKED`.

## What you can do after it

Create a mandate over HTTP, add a version, revoke it, and pull the audit events
that prove each step happened.

## Concepts it teaches

- [DTO vs domain model](../concepts/backend/05_dto-vs-domain-model.md)
- [Validation at the boundary](../concepts/backend/06_validation-at-the-boundary-zod.md)
- [Layered architecture](../concepts/backend/04_layered-architecture.md)
- [Pure functions and determinism](../concepts/backend/14_pure-functions-and-determinism.md)
- [Canonical JSON](../concepts/security/08_canonical-json.md)
- [Hash chains and tamper evidence](../concepts/security/07_hash-chains-and-tamper-evidence.md)
- [Timing attacks](../concepts/security/04_timing-attacks.md)
- [Adapters and dependency injection](../concepts/backend/13_adapters-and-dependency-injection.md)
- [Timeouts and graceful degradation](../concepts/backend/15_timeouts-and-graceful-degradation.md)

## The honest gap

The database enforces that a consent reference is **recorded**, not that a human
**agreed**. Capturing the act needs the dashboard (Phase 8). This is written
into the migration comment itself, so nobody mistakes the one for the other.
