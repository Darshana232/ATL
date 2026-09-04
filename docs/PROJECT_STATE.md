# Project State

**Read this first in any new session.** It exists so the kickoff analysis is
never repeated. Update it at the end of every phase.

**Last updated:** 2026-09-04 · **Current phase:** 1 complete, 2 design approved pending

Two documentation sets, different audiences:
- `docs/` — how it works and what was decided (operate/extend)
- `Understanding/` — why it works and what building it taught (learn/explain).
  Each `PHASE_xx` file is written in two halves: sections 1–9 before the phase,
  10–12 after. **An empty section 10/11 means the phase is not done.**

---

## Where we are

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo, docs, decision log | ✅ complete |
| 1 | Foundation: workspace, config, logging, DB pool, migrations, health | ✅ complete |
| 2 | Full core schema + seed data | ⬜ next |
| 3 | Mandate domain + API | ⬜ |
| 4 | Deterministic policy engine (7 rules) | ⬜ |
| 5 | Authorization endpoint: agent auth, HMAC, idempotency, voucher | ⬜ |
| 6 | Hash-chained audit trail + verification + tamper demo | ⬜ |
| 7 | Payment adapters (mock + Razorpay test) + webhooks | ⬜ |
| 8 | Catalog + agent runtime + scoped tools + injection test | ⬜ |
| 9 | Dashboard | ⬜ |
| 10 | Reports (FREE-AI coverage, STR draft, DPDP register) + certification | ⬜ |
| 11 | Security hardening + threat model | ⬜ |
| 12 | Observability, CI, deploy, demo polish | ⬜ |

---

## What actually exists right now

```
apps/api/src/
  config.ts          Zod-validated env -> frozen typed Config; secrets never echoed
  config.test.ts     18 tests incl. two security assertions
  logger.ts          pino, JSON, ISO timestamps, central PII/secret redaction
  env-file.ts        loads repo-root .env (entrypoints only)
  test-setup.ts      vitest setup
  server.ts          buildServer(): DI, request IDs, 404 + error handlers
  index.ts           entrypoint: boot order, DB precheck, graceful shutdown
  db/pool.ts         pg Pool, budgeted size, timeouts, idle-error recovery
  db/migrate.ts      checksummed, transactional, advisory-locked runner
  db/migrations/0001_init.sql   merchants table
  routes/health.ts   /v1/health/live (liveness) + /v1/health (readiness)
  routes/health.test.ts         7 tests incl. an information-disclosure test
```

**Verified working:** 25/25 tests green, `tsc --noEmit` clean, migration applied
and idempotent, checksum tamper detection demonstrated, all four `CHECK`
constraints proven to reject bad data via raw SQL, server boots and shuts down
gracefully, request-ID propagation confirmed.

**Environment:** Node 24.13, TypeScript 7.0.2, Vitest 5, Fastify 5.12,
PostgreSQL 16.15 via Homebrew (`brew services`), database `atl_india_dev`,
owner `darshanajain`.

---

## Next work unit — Phase 2: core schema

Full design in [`Understanding/PHASE_02_database_schema.md`](../Understanding/PHASE_02_database_schema.md)
(before-half written). Four migrations:

```
0002_identity.sql        users, agents, agent_credentials
0003_mandates.sql        mandates, mandate_versions
0004_authorization.sql   authorization_requests, decisions,
                         rule_evaluations, risk_signals, payments
0005_audit.sql           audit_events + append-only enforcement + atl_app role
```

`products`/`carts` deferred to Phase 8 (catalog); `agent_runs`/`agent_steps` to
Phase 8 (tracing) — migrating tables before the code that uses them means
guessing at their columns.

**Five design decisions, recommendations recorded in the phase file:**
1. Mandate versioning → **two tables**: `mandates` (identity + lifecycle) +
   `mandate_versions` (immutable terms, PK `(mandate_id, version)`).
2. Money → **`BIGINT` paise** with an explicit `int8` parser that throws above
   `Number.MAX_SAFE_INTEGER`.
3. Append-only → **`REVOKE` from an `atl_app` role AND a trigger**; they fail
   independently.
4. Velocity → **`SELECT … FOR UPDATE` on the mandate row** + derived `SUM()`.
   Prevents the lost-update breach; needs no retry logic.
5. Mandate snapshot on `decisions` → **no**, FK to the immutable version row is
   sufficient. The snapshot belongs in the audit payload, which must be
   self-contained for hashing.

---

## Standing constraints (do not re-litigate silently)

- The LLM never has payment authority — ADR-0008.
- Everything external sits behind an adapter — ADR-0009.
- `TIMESTAMPTZ` always; integer paise for money; prefixed text IDs — ADR-0007.
- Applied migrations are immutable — ADR-0006.
- Honest labelling of simulated components is mandatory.
- Claim ceiling is "tamper-evident", never "tamper-proof".

## Known gaps to be honest about

- **Criterion B1 (merchant validation) is MISSING.** No merchant interviews
  have happened. Research quotes appear fabricated — see
  `RESEARCH_REALITY_CHECK.md` item 10.
- No Razorpay test-mode keys yet; payment leg will be `MockUpiProvider` until
  they exist (ADR-0009).
- `docker-compose.yml` is committed but has never been run (ADR-0004).
- No CI yet; no linter configured yet (ESLint arrives with Phase 11 hardening,
  or sooner if churn justifies it).
