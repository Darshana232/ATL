# Phase 2 — The Database

**Status:** ✅ done · **Commits:** `2765686`, `bfd53c6`, `240c4e4`, `e8a8e7a`,
`1da53f0`, `bc7e49f`

---

## What it is

The entire schema, in five migrations: who exists, what they're allowed to do,
what was decided, and what happened. Plus a least-privilege database role for
the service, and deterministic seed data.

## Why it comes here

Because the schema is where the **hard guarantees** live. Immutability,
append-only-ness and deny-by-default are enforced by the database, not by
application code — so they hold even when someone connects with `psql`.

> **Analogy.** A ratchet. It's a physical shape, not a promise to only turn one
> way.

## The steps

**1. Exact money** — `money.ts`
Integer paise, always. Exact **string** parsing (not `parseFloat`), and an
`int8` guard that **throws** rather than silently approximating when a value
exceeds the safe integer range. `0.1 + 0.2 !== 0.3` is a curiosity in a tutorial
and a defect in a payment system.
→ 21 tests. Also `db/types.ts`: registering a `pg` type parser so Postgres
`BIGINT` doesn't arrive as a string.

**2. Identity** — `0002_identity.sql`
`users`, `agents`, `tools`, `agent_tool_grants`, `agent_credentials`.
The important shape: an agent has **no** capabilities by default. It gets rows
in `agent_tool_grants` naming specific tools. That is **deny-by-default** as a
table, and it's what makes "the agent can only ask" enforceable rather than
aspirational.

**3. Mandates** — `0003_mandates.sql`
Two tables, deliberately:
- `mandates` — identity and status (`active` → `revoked`, and revocation is
  **terminal**, guarded by a trigger)
- `mandate_versions` — the actual terms, **append-only**

Plus `mandate_version_merchants`, the allowlist — an **allowlist**, not a
blocklist, because deny-by-default is the only safe default when the thing being
denied is spending money.
This migration also introduces the two reusable guard functions —
`reject_mutation()` and `reject_truncate()` — used by every append-only table
after it.

**4. Authorization** — `0004_authorization.sql`
`authorization_requests`, `decisions`, `rule_evaluations`, `risk_signals`,
`payments`. All append-only except `payments`, which has a status that legally
changes — and even that is guarded by a transition trigger, so a payment cannot
go from `failed` back to `succeeded`.
`rule_evaluations` is the table that makes explainability real: **one row per
rule per decision**, so the explanation is queryable data, not prose.

**5. Audit + the runtime role** — `0005_audit.sql`
`audit_events` with `chain_id`, `seq`, `prev_hash`, `hash`. And then the part
that matters most:

```sql
CREATE ROLE atl_app LOGIN;
GRANT SELECT, INSERT ON ALL TABLES ... TO atl_app;
GRANT UPDATE ON users, agents, merchants, mandates, payments, ... TO atl_app;
REVOKE UPDATE, DELETE ON <every append-only table> FROM atl_app;
REVOKE DELETE ON ALL TABLES ... FROM atl_app;
REVOKE CREATE ON SCHEMA public FROM atl_app;
```

The service runs as `atl_app`. The developer runs migrations as the owner. Two
roles, and the service **cannot** delete a row anywhere, or update an audit
event, even if you asked it to.

**6. Seed data** — `db/seed.ts`
Deterministic, offline, idempotent. Real Indian merchants with real ISO 18245
MCCs; merchants in restricted categories use *invented* names deliberately.

## What you can do after it

Run `npm run migrate && npm run seed`, then connect as `atl_app` and try to
`UPDATE` an audit row — and watch the database refuse you.

## The tests are the interesting part

**56 schema tests** (as the owner) and **14 role tests** (as `atl_app`). The
philosophy: *prove claimed properties, don't assert them.* Every constraint and
trigger is proven by **attacking it** — try the update, assert the rejection.
Least privilege is proven by connecting as the real runtime role, not by reading
the grant statements.

## Concepts it teaches

- [Why a relational database](../concepts/database/01_why-a-relational-database.md)
- [Constraints: CHECK, UNIQUE, NOT NULL](../concepts/database/03_constraints-check-unique-notnull.md)
- [Transactions and ACID](../concepts/database/04_transactions-and-acid.md)
- [Append-only tables and triggers](../concepts/database/07_append-only-tables-and-triggers.md)
- [Least-privilege database roles](../concepts/database/08_least-privilege-database-roles.md)
- [Money, timestamps and IDs](../concepts/database/10_money-timestamps-and-ids.md)
- [Versioned records](../concepts/database/11_versioned-records-immutability.md)

## The honest gap

The schema enforces the guarantees; **nothing uses it yet**. And one thing the
schema could not know it needed: consent columns, which arrive in Phase 3 and
turn out to be awkward *because* of the append-only trigger written here.
