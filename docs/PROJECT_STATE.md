# Project State

**Read this first in any new session.** It exists so the kickoff analysis is
never repeated. Update it at the end of every phase.

**Last updated:** 2026-09-05 · **Current phase:** 6 complete, 7 in progress

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
| 4 | Deterministic policy engine (12 rules; 13th added in Phase 5) | ✅ complete |
| 5 | Authorization endpoint: agent auth, idempotency, replay, voucher | ✅ complete |
| 6 | Hash-chained audit trail + `/verify` + tamper demo | ✅ complete |
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

## Added in Phase 5

```
apps/api/src/
  auth/signing.ts          canonical signing string, Ed25519 verify, freshness
  middleware/agent-auth.ts preHandler: headers, freshness, credential, signature
  voucher/voucher.ts       HMAC-SHA256 capability token; jti derived per decision
  repositories/credential.ts  key lookup + last_used_at telemetry
  repositories/spend.ts    FOR UPDATE lock, timezone-aware windows, spend query
  repositories/authorization.ts  request/decision/rule/risk writes; replay read
  providers/risk.ts        RiskProvider + MockRiskProvider (SIMULATED) + Null
  dto/authorization.ts     Zod strictObject wire schemas
  routes/authorize.ts      POST /v1/authorize
  demo/authorize-demo.ts   live demo over a real socket with real signatures
  policy/rules.ts          + MANDATE_AGENT_MATCH (rule 1); ENGINE_VERSION v2
```

**Verified working:** 448 tests green, `tsc --noEmit` clean, **no new
migration** (every column was designed in Phase 2), and the whole flow exercised
live over real HTTP with real Ed25519 signatures — PASS with a verifiable
voucher, four distinct BLOCK reasons, an idempotent replay returning the same
decision id, and a one-digit body tamper rejected with 401.

**Two positive controls were run and both failed as required:** breaking
`MANDATE_AGENT_MATCH` failed 4 tests; removing `FOR UPDATE` failed the
concurrency test. A concurrency test that cannot fail is not evidence.

---

## Added in Phase 6

```
apps/api/src/
  audit/verifier.ts        streaming chain verification + checkpoint checks
  audit/checkpoint.ts      HMAC-signed anchors; constant-time verification
  repositories/audit.ts    keyset chain cursor, summary, checkpoint I/O
  routes/audit.ts          GET /v1/audit/verify, /events; POST /checkpoint
  demo/tamper-demo.ts      the buildathon moment, run as a privileged insider
  db/migrations/0007_audit_checkpoints.sql
  config.ts                + AUDIT_CHECKPOINT_SECRET (must differ from the
                             voucher secret; config refuses to boot if equal)
```

**Verified working:** 499 tests green, `tsc --noEmit` clean, 7 migrations
applied. Tampering is proven by *doing* it: an edited payload, an edited actor,
an edited timestamp, a deleted event, a removed genesis, and a
payload-edited-and-rehashed row are each detected and named, with the same chain
asserted `intact` immediately beforehand as a control.

**Two findings worth carrying forward:**
1. The append-only trigger fires **for the table owner too**. A privileged
   insider must `ALTER TABLE … DISABLE TRIGGER` first — owner-only DDL that
   PostgreSQL logs. The barrier is higher than the design claimed.
2. A verifier bug found by a test: a missing anchored event reported
   `unreachable`, which did not mark the chain broken — so **deleting the whole
   trail read as `intact`**. Fixed; `unreachable` now means only "no secret
   configured".

---

## Next work unit — Phase 7: payments and the agent runtime

Write the before-half of `Understanding/PHASE_07_payments_and_agent.md` first.

Both halves are adapter work on the **outside** of the trust boundary — one
adapting to a payment rail, one to a language model — and neither is a demo
without the other (ADR-0014).

**Payments**
1. `PaymentProvider` interface + `MockUpiProvider` (default, labelled
   SIMULATED) + `RazorpayTestProvider` (real test-mode API, when keys exist).
2. **The voucher becomes load-bearing:** capture is refused without a valid,
   unexpired, single-use voucher. `payments.voucher_jti UNIQUE` is what makes
   single use a database fact.
3. Webhooks with signature verification, replay protection and idempotent
   handling — a duplicate webhook must not double-capture.

**Agent runtime**
4. Catalog provider (hand-seeded, Indian, with real MCCs — ADR-0013).
5. Scoped tools: an agent receives only the tools `agent_tool_grants` permits.
6. **The prompt-injection test.** A fully injected agent must still be unable to
   move money — it can only ask, and asking goes through code it does not
   control. This is the test that proves ADR-0008.
7. MCP-compatible interface, if it earns its place.

Owed from earlier phases: `EXPLAIN ANALYZE` on `loadForAuthorization` and the
spend query, with real row counts.

## Documentation structure — SETTLED

`Understanding/` is **canonical**. Its `PHASE_xx` files are the ones to read and
to write, and they follow the **nine-phase roadmap in the table above**
(ADR-0014). Phases 0–6 kept their original numbers, so every existing
`PHASE_00`–`PHASE_06` reference remains correct; only the unbuilt tail was
reshaped. An earlier version of this paragraph still said "13-phase plan", which
contradicted the table — corrected 2026-09-05.

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
- **Read endpoints are unauthenticated**, and the mandate-mutation admin key is
  one shared secret with no rotation or per-caller identity — so `createdBy`
  records a *claim* about who acted, not a verified identity. Phase 5 fixed this
  for `POST /v1/authorize` (real Ed25519 signatures); mandate mutation needs
  user sessions with RBAC, which is Phase 9.
- `authorization_requests.signature_verified` **can only ever be true**, because
  a failed-signature request cannot satisfy that row's foreign keys. Rejections
  are recorded in the audit chain instead. See PHASE_05 §12.
- **No rate limiting.** A valid credential can make unlimited requests. Each
  takes a row lock on its own mandate, so an agent degrades only its own
  throughput — bounded, but Phase 9 work.
- `appendAuditEvent` cannot verify it is inside a transaction; enforced by
  documentation and the `txClient` parameter name.
- Route and audit tests permanently add rows (those tables are append-only by
  design); cleared only by the full reset in `docs/DATABASE.md`.
- The GitHub repo is **public**. `Research/` contains fabricated attributions;
  the README carries a prominent disclaimer.
