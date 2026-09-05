# Project State

**Read this first in any new session.** It exists so the kickoff analysis is
never repeated. Update it at the end of every phase.

**Last updated:** 2026-09-05 · **Current phase:** 8 complete, 9 in progress

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
| 7 | Payments (adapters + webhooks) **and** the agent runtime (catalog, scoped tools, injection test, MCP) | ✅ complete |
| 8 | Dashboard **and** reports (FREE-AI coverage, STR draft, DPDP register) | ✅ complete |
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

## Added in Phase 7

```
apps/api/src/
  providers/payment.ts     PaymentProvider + MockUpi (SIMULATED, deterministic)
                           + RazorpayTest (real test-mode API, refuses live keys)
  providers/catalog.ts     catalog search, scoped to the mandate's merchants
  repositories/payment.ts  insert (the single-use gate) + lifecycle transitions
  repositories/webhook.ts  delivery recording, unique per provider event id
  routes/payments.ts       POST /v1/payments, GET /v1/payments/:id
  routes/webhooks.ts       POST /v1/webhooks/razorpay
  webhooks/signature.ts    raw-body HMAC verification
  agent/tools.ts           ONE registry, ONE scope check, two transports
  agent/executor.ts        tool execution; payments go over signed HTTP
  agent/provider.ts        AgentProvider + MockAgent (credulous, on purpose)
                           + ClaudeAgentProvider (real Anthropic API)
  agent/runtime.ts         the loop; summary generated from facts, not the model
  agent/injection.test.ts  THE test
  mcp/server.ts            stdio MCP server over the same registry
  demo/agent-demo.ts       four runs, including the injection
  db/migrations/0008_catalog.sql, 0009_webhooks.sql
```

**Verified working:** 580 tests green, `tsc --noEmit` clean, 9 migrations. The
MCP server was driven over stdio and lists exactly the seven granted tools.
The agent demo runs end to end on a real socket with real signatures.

**Positive controls run:**
- Letting the agent reach a payment provider directly (the ADR-0008 violation)
  fails exactly the three tests that assert the boundary holds.
- Disabling voucher verification revealed that the injection tests were passing
  because the forged token was **too short for the request schema** — the MAC
  was never reached. Fixed by making the forgery realistic. Documented in
  PHASE_07 §11.

**Four independent gates** stop a forged voucher: request schema, MAC,
claims-match-request, and decision-exists-and-passed. Removing any one still
blocks the payment — discovered by removing them one at a time.

---

## Added in Phase 8

```
apps/api/src/
  reports/controls.ts      26 controls in scope, each with its OWN query
  reports/free-ai.ts       coverage: 20/26, a ratio, never a percentage
  reports/str.ts           deterministic candidates; DRAFT only, never filed
  reports/dpdp.ts          register declared in code, counted from the database
  repositories/report.ts   stored reports, immutable bodies, review lifecycle
  routes/reports.ts        GET the three reports; generate; review
  routes/console.ts        operator reads for the dashboard
  db/migrations/0010_reports.sql

apps/dashboard/            Next.js 16, eleven screens (ADR-0002)
  src/lib/api.ts           the ONLY place the console talks to the API
  src/app/globals.css      design system: colour carries meaning, nothing else
  src/app/…                overview, decisions (+detail), payments, risk,
                           mandates, agents, audit, three reports
docs/PERFORMANCE.md        EXPLAIN ANALYZE, owed since Phase 2
```

**Verified working:** 632 tests green, `tsc --noEmit` clean in both workspaces,
`next build` clean, and all eleven routes served 200 against the live API. The
rendered HTML was checked for the constraints that matter: no percentage and no
"compliant" on the coverage screen, "DRAFT — HUMAN REVIEW REQUIRED" and "cannot
and will not file" on the STR screen, and SIMULATED badges on the overview.

**The finding of the phase:** the first coverage report returned **20/20 with
zero gaps**. Every individual control was honest; the dishonesty was in the
*selection*. The in-scope set now includes six controls we have not built —
including "NO MERCHANT INTERVIEWS HAVE TAKEN PLACE" — so the number can move.
See ADR-0022.

**Performance debt paid.** All three hot queries are index scans, sub-millisecond,
with plan shapes recorded in `docs/PERFORMANCE.md` — including one finding: the
audit-chain page currently prefers the primary key over the composite chain
index and filters 171 rows, which is correct at this size and will stop being
correct with per-merchant chains.

---

## Next work unit — Phase 9: hardening and shipping

Write the before-half of `Understanding/PHASE_09_hardening.md` first.

One "make it shippable" pass (ADR-0014):

1. **Threat model** — `docs/THREAT_MODEL.md`, STRIDE over the three trust zones,
   with each mitigation pointing at the test that proves it.
2. **RBAC and user sessions** — closes gap ATL-C22. Replaces the shared admin
   key; makes `createdBy` a verified identity rather than a claim. Also closes
   the open mandate READ endpoints inherited from Phase 3.
3. **Rate limiting** — closes gap ATL-C23.
4. **ESLint + Prettier**, and CI running typecheck, lint and the full suite.
5. **Observability** — request/agent/mandate/decision ids already flow through
   the logs; add timing and a trace view.
6. **Deployment** — the committed `docker-compose.yml` has never been run
   (ADR-0004). Either exercise it or say so in the README.
7. **Demo polish** — one script that tells the whole story end to end.

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
