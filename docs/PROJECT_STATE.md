# Project State

**Read this first in any new session.** It exists so the kickoff analysis is
never repeated. Update it at the end of every phase.

**Last updated:** 2026-09-04 · **Current phase:** 2 complete, 3 not started

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
| 2 | Full core schema + seed data | ✅ complete |
| 3 | Mandate domain + API | ⬜ next |
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

Added in Phase 2:

```
apps/api/src/
  money.ts + money.test.ts        integer paise; exact string parsing; int8
                                  guard that throws instead of approximating
  db/types.ts + types.test.ts     pg int8 type-parser registration
  db/seed.ts                      deterministic, offline, idempotent fixtures
  db/schema.test.ts               53 schema-guarantee tests (as OWNER)
  db/roles.test.ts                14 least-privilege tests (as atl_app)
  db/migrations/
    0002_identity.sql             users, agents, tools, grants, credentials
    0003_mandates.sql             mandates + immutable versions + allowlist
    0004_authorization.sql        requests, decisions, rules, risk, payments
    0005_audit.sql                audit_events + the atl_app role
```

**Verified working:** 118 tests green (twice in a row, leaving no residue),
`tsc --noEmit` clean, 5 migrations applied and idempotent, checksum tamper
detection demonstrated, every constraint and trigger proven by attacking it,
least privilege proven by connecting as the real runtime role, seed idempotent,
service boots as `atl_app`.

**Environment:** Node 24.13, TypeScript 7.0.2, Vitest 5, Fastify 5.12,
PostgreSQL 16.15 via Homebrew (`brew services`), database `atl_india_dev`.
**Two roles:** owner `darshanajain` (migrations, seed, schema tests) and
`atl_app` (the service). See `docs/DATABASE.md`.

---

## Next work unit — Phase 3: mandates

Write the before-half of `Understanding/PHASE_03_mandates.md` first, then build.

The schema already enforces the hard guarantees (immutable versions, terminal
revocation, deny-by-default allowlist). Phase 3 is the domain layer and the API
on top of it:

1. **Domain types** in `packages/core` — `Mandate`, `MandateVersion`, `Money`
   as branded types. Pure, no I/O, so Phase 4's engine can consume them.
2. **DTO vs domain model** — the wire shape (rupee strings, ISO dates) is not
   the internal shape (integer paise, `Date`). Zod at the boundary.
3. **Repository** — load a mandate with its current version and allowlist in
   one query; load a *specific* version for re-explaining a past decision.
4. **API**: `POST /v1/mandates`, `GET /v1/mandates/:id`,
   `POST /v1/mandates/:id/versions`, `POST /v1/mandates/:id/revoke`.
5. **Cold-path IFSC lookup** (ADR-0013) — validate an IFSC at mandate
   creation via Razorpay's public API, with a timeout and graceful
   degradation. Never on the authorization path.
6. **First audit events** — `MANDATE_CREATED`, `MANDATE_VERSION_ADDED`,
   `MANDATE_REVOKED`. Written unchained for now; Phase 6 adds the hash chain.

Open question to settle in the before-half: does creating a version require
re-consent from the user, and how is that recorded given the consent-ledger
gap noted in PHASE_02 §12?

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
