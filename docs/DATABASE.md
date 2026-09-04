# Database

PostgreSQL 16. Five migrations, 15 tables, two roles.

Design rationale lives in [`../Understanding/PHASE_02_database_schema.md`](../Understanding/PHASE_02_database_schema.md);
this file is the reference.

---

## Entity relationships

```
┌──────────┐        ┌──────────┐        ┌───────────────────┐
│  users   │        │  agents  │───┬───►│ agent_credentials │  Ed25519 public keys
└────┬─────┘        └────┬─────┘   │    └───────────────────┘
     │                   │         │    ┌───────────────────┐   ┌───────┐
     │                   │         └───►│ agent_tool_grants │──►│ tools │
     │                   │              └───────────────────┘   └───────┘
     └─────────┬─────────┘                  tool-level authorization
               ▼
        ┌─────────────┐   identity + lifecycle (status: active | revoked)
        │  mandates   │
        └──────┬──────┘
               │ 1:N
               ▼
     ┌───────────────────┐  IMMUTABLE terms.  PK (mandate_id, version)
     │ mandate_versions  │  current = MAX(version), never stored
     └─────────┬─────────┘
               │ 1:N              ┌────────────┐
               ├─────────────────►│ merchants  │  via mandate_version_merchants
               │                  └────────────┘  (allowlist, FK-checked)
               ▼
     ┌────────────────────────┐        ┌──────────────┐
     │ authorization_requests │◄───────│ risk_signals │  advisory only
     └───────────┬────────────┘        └──────────────┘
                 │ 1:1
                 ▼
          ┌─────────────┐
          │  decisions  │  verdict PASS | FLAG | BLOCK
          └──────┬──────┘
                 │ 1:N
                 ├────────────────►┌──────────────────┐
                 │                 │ rule_evaluations │  one row per rule, incl. passes
                 │                 └──────────────────┘
                 │ 1:1
                 ▼
          ┌────────────┐   voucher_jti UNIQUE = single-use, enforced by the DB
          │  payments  │   created → authorized → captured → refunded
          └────────────┘                     └→ failed

          ┌────────────────┐
          │  audit_events  │  APPEND-ONLY, hash-chained. Written for every
          └────────────────┘  consequential event above.
```

## Migrations

| File | Contents |
|---|---|
| `0001_init.sql` | `merchants` |
| `0002_identity.sql` | `users`, `agents`, `tools`, `agent_tool_grants`, `agent_credentials`, `set_updated_at()` |
| `0003_mandates.sql` | `mandates`, `mandate_versions`, `mandate_version_merchants`, `mcc_code` domain, `reject_mutation()`, `reject_truncate()`, lifecycle guard |
| `0004_authorization.sql` | `authorization_requests`, `decisions`, `rule_evaluations`, `risk_signals`, `payments`, payment state machine |
| `0005_audit.sql` | `audit_events`, chain-integrity indexes, the `atl_app` role and its grants |

Applied migrations are **immutable** — the runner stores a SHA-256 of each and
refuses to proceed if a file changed. Add `0006_*.sql`; never edit an applied
one. (The one exception is a migration that is still local and uncommitted,
which is `git commit --amend`, not `git revert`.)

## Two roles

| Role | Used by | Privileges |
|---|---|---|
| owner (your OS user) | `npm run migrate`, `npm run seed`, `schema.test.ts` | DDL, everything |
| `atl_app` | **the running service** (`DATABASE_URL`) | `SELECT`/`INSERT` broadly; `UPDATE` only on `users`, `agents`, `merchants`, `mandates`, `payments`, `agent_credentials`, `tools`; **no `DELETE`, no `TRUNCATE`, no DDL, anywhere** |

Verified in `roles.test.ts`. The startup log reports `databaseUser` and
`separateMigrationRole`, so least privilege is observable at boot.

## Append-only tables

`mandate_versions` · `mandate_version_merchants` · `authorization_requests` ·
`decisions` · `rule_evaluations` · `risk_signals` · `audit_events`

Enforced **three** ways, because each covers a different attack:

| Layer | Stops | Verified by |
|---|---|---|
| Revoked `UPDATE`/`DELETE`/`TRUNCATE` grants on `atl_app` | a compromised or buggy application | `roles.test.ts` (SQLSTATE `42501`) |
| `BEFORE UPDATE OR DELETE ... FOR EACH ROW` trigger | a misconfigured grant, and the owner | `schema.test.ts` (SQLSTATE `ATL01`) |
| `BEFORE TRUNCATE ... FOR EACH STATEMENT` trigger | `TRUNCATE`, which **does not fire row-level triggers at all** | `schema.test.ts` (SQLSTATE `ATL01`) |

Even the owner cannot `DELETE` or `TRUNCATE` these tables. The dev reset path
is drop the table and re-migrate.

## Custom SQLSTATEs

Asserted by tests instead of message strings, so a wording change cannot
silently disable a test.

| Code | Meaning |
|---|---|
| `ATL01` | append-only table mutation attempted |
| `ATL02` | illegal lifecycle transition (mandate revival, party change, bad payment transition, amount/voucher edit) |

## Conventions

- **Money**: `BIGINT` paise, column names end `_paise`. Never floats. An
  `int8` parser throws above `Number.MAX_SAFE_INTEGER` rather than returning an
  approximation. See `src/money.ts`.
- **Time**: `TIMESTAMPTZ` everywhere, stored UTC, formatted at the edge.
  `mandate_versions.timezone` records the user's zone, because "8am–8pm" is
  local while storage is not.
- **IDs**: prefixed text — `usr_`, `agt_`, `cred_`, `mer_`, `mnd_`, `authz_`,
  `dec_`, `pay_`, `rsk_`, `evt_`.
- **Enums**: `TEXT` + `CHECK`, not Postgres `ENUM` (adding a value stays a
  one-line migration).
- **Deletion**: `ON DELETE RESTRICT` everywhere. `CASCADE` in a system whose
  product is evidence is a mechanism for destroying evidence by accident.
- **JSONB vs columns**: anything a **rule** reads is a column; anything only a
  **human** reads may be JSONB (`authorization_requests.cart`,
  `mandate_versions.notes`, `audit_events.payload`).
- **`CHECK` semantics**: a `CHECK` fails only when it evaluates to `FALSE`, not
  when it is `NULL`. Use `cardinality()` (0 for empty) rather than
  `array_length()` (NULL for empty), or the constraint silently does nothing.

## Notable indexes

| Index | Serves |
|---|---|
| `payments_spend_window_idx (mandate_id, captured_at DESC) WHERE status='captured'` | **the hot path** — window spend on every authorization |
| `mandate_versions_current_idx (mandate_id, version DESC)` | "current terms for this mandate" |
| `audit_events_single_genesis_idx (chain_id) WHERE prev_hash IS NULL` | exactly one chain start — blocks a parallel forged chain |
| `audit_events_no_fork_idx (chain_id, prev_hash) WHERE prev_hash IS NOT NULL` | no chain forks — two divergent histories cannot both verify |
| `decisions_exceptions_idx WHERE verdict IN ('BLOCK','FLAG')` | reports care about exceptions, not the PASS majority |
| `rule_evaluations_by_rule_verdict_idx (rule_code, verdict, created_at DESC)` | "all cap breaches this month" — STR candidates |
| `authorization_requests_bad_signature_idx WHERE signature_verified=false` | security review of rejected signatures |
| `payments_in_flight_idx WHERE status IN ('created','authorized')` | reconciling stuck payments |

## `audit_events.seq` is not an integrity mechanism

`seq` is a `BIGSERIAL` used for ordering. **Sequence gaps are normal** —
PostgreSQL sequences do not roll back, so an aborted transaction consumes a
number permanently. A gap detector would raise false alarms on every rollback.

The **hash chain** is the authority: each row commits to its predecessor, so
altering or removing an earlier row breaks every hash after it.

## Commands

```bash
npm run migrate           # apply pending migrations (idempotent)
npm run seed              # deterministic dev fixtures (idempotent)
npm run seed -- --rotate-keys
npm run db:psql
npm test                  # includes schema + role guarantee tests
```

**Full local reset** (needed because append-only tables cannot be emptied):

```bash
/opt/homebrew/opt/postgresql@16/bin/dropdb   atl_india_dev
/opt/homebrew/opt/postgresql@16/bin/createdb atl_india_dev
npm run migrate && npm run seed
```

## Seed contents

9 merchants (incl. one suspended, plus liquor `5921` and gambling `7995` for
category blocking) · 4 users with real bank data from Razorpay's public IFSC
API · 3 agents (one suspended) · 10 tools, of which **4 sensitive ones are
granted to nobody** · 2 Ed25519 credentials · 6 mandates, 8 versions.

Deliberately messy: an expired mandate, a revoked mandate, a mandate with an
**empty allowlist** (deny by default), a ₹100 cap for boundary testing, and one
mandate with **three superseding versions** so the versioning guarantee is
demonstrable on real rows.

**No transaction history is seeded.** Hand-written decisions would be fabricated
evidence that does not match what the engine produces. Phases 4–5 generate it
by running the real engine.
