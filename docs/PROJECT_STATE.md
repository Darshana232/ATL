# Project State

**Read this first in any new session.** It exists so the kickoff analysis is
never repeated. Update it at the end of every phase.

**Last updated:** 2026-09-05 · **Current phase:** 3 complete, 4 not started

Two documentation sets, different audiences:
- `docs/` — how it works and what was decided (operate/extend)
- `Understanding/` — why it works and what building it taught (learn/explain).
  Each `PHASE_xx` file is written in two halves: sections 1–9 before the phase,
  10–12 after. **An empty section 10/11 means the phase is not done.**

---

## Where we are

**Nine build phases**, plus a Phase 0 prologue that was repo setup rather than
product. Consolidated from thirteen on 2026-09-05 — see **ADR-0014**. Phases
0–6 keep their original numbers, so existing references stay correct.

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo, docs, decision log, research reality-check | ✅ complete |
| 1 | Foundation: workspace, config, logging, DB pool, migrations, health | ✅ complete |
| 2 | Full core schema + least-privilege role + seed data | ✅ complete |
| 3 | Mandate domain, DTOs, repository, audit writer, mandate API | ✅ complete |
| 4 | Deterministic policy engine (7 rules) | ⬜ next |
| 5 | Authorization endpoint: agent auth, HMAC, idempotency, replay, voucher | ⬜ |
| 6 | Hash-chained audit trail + `/verify` + tamper demo | ⬜ |
| 7 | Payments (adapters + webhooks) **and** the agent runtime (catalog, scoped tools, injection test, MCP) | ⬜ |
| 8 | Dashboard **and** reports (FREE-AI coverage, STR draft, DPDP register) | ⬜ |
| 9 | Hardening: threat model, RBAC, rate limits, ESLint, CI, observability, deploy, demo | ⬜ |

A plain-English companion to this roadmap — one file per phase, plus 67 concept
cards and a file-by-file codebase tour — lives in
`Concepts Learning and Understanding/`.

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

Added in Phase 3:

```
apps/api/src/
  domain/mandate.ts       MandateTerms value object; validates what SQL cannot
                          (real IANA timezone, duplicates inside arrays)
  dto/mandate.ts          Zod wire schemas (strictObject) + domain mappers
  repositories/mandate.ts SQL for the aggregate; loadForAuthorization is ONE
                          query via JOIN LATERAL (asserted by a query counter)
  audit/canonical.ts      canonical JSON + sha256; rejects rather than coerces
  audit/writer.ts         hash chain; advisory lock; hashes the WHOLE record
  providers/bank-lookup.ts  Razorpay IFSC (cold path only) / Static / Failing
  middleware/admin-auth.ts  shared key, timingSafeEqual over SHA-256 digests
  routes/mandates.ts      6 endpoints; every mutation + its audit event in ONE
                          transaction
  db/transaction.ts       withTransaction helper
  db/migrations/0006_consent.sql  consent_ref + consent_at, NOT NULL
```

**Verified working:** 275 tests green, `tsc --noEmit` clean, 6 migrations
applied to an empty database in order, every constraint and trigger proven by
attacking it, least privilege proven by connecting as the real runtime role,
audit chain intact across 56+ events, and the whole flow exercised live over
HTTP (create → add version → read v1 unchanged → revoke → 409), including a
real call to Razorpay's public IFSC API returning live HDFC Bank data.

**Endpoints:** see `docs/API.md`. Mutations require `x-atl-admin-key`
(placeholder auth — Phase 5 replaces it). Reads are currently open.

**Environment:** Node 24.13, TypeScript 7.0.2, Vitest 5, Fastify 5.12,
PostgreSQL 16.15 via Homebrew (`brew services`), database `atl_india_dev`.
**Two roles:** owner `darshanajain` (migrations, seed, schema tests) and
`atl_app` (the service). See `docs/DATABASE.md`.

---

## Next work unit — Phase 4: the policy engine

Write the before-half of `Understanding/PHASE_04_policy_engine.md` first.

**This is the heart of the product** and the best engineering lesson in the
project: a pure, deterministic function that takes a mandate version, a
request, current spend, a clock reading and a risk signal, and returns a typed
`Decision` with a per-rule breakdown.

1. **Pure functions.** The engine takes NO `Date.now()`, no database handle,
   no network. Time and state are passed in. That is what makes it
   deterministic, replayable and testable without infrastructure.
2. **Seven rules**, each emitting `Signal → Rule → Evaluation → Verdict →
   Reason` as a typed record produced by code — never prose from a model.
   Per-txn limit · window limit · merchant allowlist · category (MCC) ·
   velocity · expiry · revocation. Risk is advisory input only.
3. **Boundary-value tests** on every limit: `==`, `+1`, `-1`.
4. **Exhaustive `switch` over `Verdict`** so the compiler catches an unhandled
   case.
5. **The reason must contain numbers** — "exceeds the ₹2,000 limit by ₹4,200",
   not "limit exceeded".
6. **The time-window rule needs timezone conversion** (`mandate_versions.timezone`
   is stored for exactly this): "08:00–20:00" is user-local, storage is UTC.
7. **The correction the research got wrong:** `MANDATE_PER_TXN_LIMIT` (user-set)
   and `AFA_EXEMPTION_THRESHOLD` (regulatory, NPCI UPI/OC-151A) are two
   different rules with two different owners. Ours enforces the first and only
   records the second.

Owed from earlier phases: `EXPLAIN ANALYZE` on `loadForAuthorization` and the
Phase 2 spend query, with real row counts.

## Documentation structure — SETTLED

`Understanding/` is **canonical**, with the **13-phase plan (0–12)** listed
above. Its `PHASE_xx` files are the ones to read and to write.

`Concepts Learning and Understanding/` is a parallel 10-phase rewrite that was
added later. It is **not** the plan we follow; where the two disagree about
phase numbering, `Understanding/` wins. Do not resume work from it.

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
- **Read endpoints are unauthenticated**, and the admin key is one shared
  secret with no rotation or per-caller identity — so `createdBy` records a
  *claim* about who acted, not a verified identity. Phase 5 fixes this.
- `appendAuditEvent` cannot verify it is inside a transaction; enforced by
  documentation and the `txClient` parameter name.
- Route and audit tests permanently add rows (those tables are append-only by
  design); cleared only by the full reset in `docs/DATABASE.md`.
- The GitHub repo is **public**. `Research/` contains fabricated attributions;
  the README carries a prominent disclaimer.
