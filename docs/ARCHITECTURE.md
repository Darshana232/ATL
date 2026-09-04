# Architecture

**Status:** target architecture, with Phase 1 built. Sections marked *(Phase N)*
do not exist yet.

---

## The organising idea: three trust zones

```
 ZONE 1: UNTRUSTED                ZONE 2: TRUSTED                    ZONE 3: EVIDENCE
 (the LLM lives here)             (deterministic, no LLM)            (write-once)

┌──────────────────────┐   HMAC   ┌─────────────────────────┐      ┌──────────────────┐
│  AGENT RUNTIME       │  signed  │  ATL-INDIA CORE API     │      │  AUDIT LOG       │
│  (Phase 8)           │  request │  ────────────────────   │      │  (Phase 6)       │
│  Claude + tools      │ ───────► │  1. authenticate agent  │ ───► │  append-only     │
│  · parse intent      │          │  2. load mandate + ver  │      │  SHA-256 chained │
│  · search catalog    │          │  3. POLICY ENGINE       │      │  seq + prev_hash │
│  · rank, build cart  │ ◄─────── │     7 rules, pure fn    │      │  /verify         │
│  · request authz     │  verdict │  4. DECISION + reasons  │      └──────────────────┘
│                      │  + reason│  5. mint VOUCHER ───┐   │               ▲
│  CANNOT: read/write  │          │     single-use, 60s │   │               │ every
│  mandates, capture   │          └─────────────────────┼───┘               │ state
│  payments, write     │                                │                   │ change
│  audit, choose rules │                                ▼                   │
└──────────────────────┘                  ┌──────────────────────────┐      │
                                          │  PAYMENT SERVICE (Ph 7)  │──────┘
                                          │  refuses capture without │
                                          │  a valid unused voucher  │
                                          │  ┌────────────────────┐  │
                                          │  │ PaymentProvider    │  │
                                          │  │ ├ MockUpi   SIM    │  │
                                          │  │ └ RazorpayTest REAL│  │
                                          │  └────────────────────┘  │
                                          └──────────────────────────┘
                                                       │
    ┌──────────────────────────────────────────────────┴───────────────────┐
    │  DASHBOARD (Phase 9) — session auth + RBAC                           │
    │  Overview · Transactions · Decision detail · Agent trace · Mandates  │
    │  Agents · Audit + Integrity · Reports · Certification                │
    └──────────────────────────────────────────────────────────────────────┘
```

**Why zones rather than layers.** The security property we are selling is not
"we validate carefully" — it is "the component that can be manipulated by
untrusted text has no path to money." Zone 1 holds the LLM and is assumed
compromisable (prompt injection is a *when*, not an *if*). Zone 2 is
deterministic code with no model in it. Zone 3 is write-once.

The **voucher** is what makes the boundary real instead of decorative: on
`PASS`, the policy engine mints a single-use, short-lived signed capability
token, and the payment service will not capture money without one. A fully
prompt-injected agent can still only *ask*.

---

## Components

| Component | Responsibility | Real / Simulated | Phase |
|---|---|---|---|
| Core API (Fastify) | Agent auth, mandates, authorization, audit writes, reports | REAL | 1–7 |
| Policy engine (`packages/core`) | 7 pure rule functions → typed `Decision`. No I/O, no LLM, no clock, no randomness | REAL | 4 |
| Audit service | Canonical JSON, hash chain, checkpoints, verification, tamper demo | REAL | 6 |
| Agent runtime | Claude tool-calling loop, scope-filtered toolset, trace emission | REAL (real LLM) | 8 |
| Catalog | Products, MCCs, prices | **SIMULATED** — seeded fixtures | 8 |
| Mandate rail | Creation, versioning, revocation | **PROPOSED/SIMULATED** — NPCI UAP has no public spec | 3 |
| Payment provider | Order → capture → webhook | **ADAPTER**: MockUpi (default) / RazorpayTest (real test mode) | 7 |
| Risk provider | `riskScore` 0–100 + reasons | **MOCKED** — "AFRI" does not exist | 4 |
| Dashboard (Next.js) | Every human surface | REAL | 9 |
| MCP server | Same tools over MCP, so Claude Desktop can drive the demo | REAL, nice-to-have | 8 |

---

## Communication

- **Agent → Core:** HTTPS, `X-ATL-Key` + `X-ATL-Signature` (HMAC-SHA256 over
  timestamp + body) + `Idempotency-Key`. A timestamp window plus a nonce store
  defeats replay.
- **Core → Payment:** in-process; voucher required.
- **Payment → Core:** webhook with signature verification (real Razorpay HMAC
  verification when test keys exist).
- **Dashboard → Core:** session cookie, RBAC-checked, read-mostly.
- Everything carries a `requestId`; agent work additionally carries a `runId`,
  so one flow is a single query.

---

## Where the LLM is and is not permitted

**Permitted (proposal and presentation):** parsing natural-language intent into
a structured proposal; formulating catalog queries; ranking and selecting
products with a stated rationale; drafting prose *about* decisions already made;
summarising reports; read-only parameterised dashboard queries.

**Forbidden (authority):** computing a verdict; reading or writing mandates
directly; changing limits; calling payment capture; writing audit events;
choosing which rules run; anything that could widen its own scope.

Rationale in [ADR-0008](DECISIONS.md).

---

## Built in Phase 1

```
apps/api/src/
  config.ts       Zod-validated env → frozen typed Config. The only module
                  that reads process.env. Reports every problem at once,
                  never echoes a received value, requires the voucher secret
                  in production.
  logger.ts       pino: JSON, ISO-8601 timestamps, service/env on every line,
                  central redaction of credentials and PII by field path.
  env-file.ts     Loads repo-root .env. Entrypoints only.
  server.ts       buildServer({config, logger, pool}) — dependency injection,
                  request IDs (honouring x-request-id), 404 + error handlers
                  that describe 4xx and never describe 5xx.
  index.ts        Boot order: env → config → logger → DB precheck → listen →
                  signal handlers. Refuses to start if Postgres is unreachable.
                  Graceful shutdown with a hard timeout guard.
  db/pool.ts      pg Pool with a cluster-budgeted size, connection timeout as
                  backpressure, and an idle-error handler so a database blip
                  cannot crash the process.
  db/migrate.ts   Migration runner: filename-ordered, transactional,
                  advisory-locked, checksum-verified. Editing an applied
                  migration is a hard error.
  routes/health.ts  /v1/health/live (liveness, touches nothing) and
                  /v1/health (readiness, queries Postgres, 503 when degraded,
                  leaks nothing about why).
```

**Data model so far:** `merchants` (+ `schema_migrations`). The full domain
model is Phase 2.

---

## What changes at scale

| Volume | First thing that breaks | Response |
|---|---|---|
| 10 merchants | nothing | — |
| 10k merchants | Dashboard queries scanning the audit table | Time-partition `audit_events`; read replica for the dashboard |
| 10M transactions | Velocity counting under concurrent authorizations | Serializable transaction on a counter row, or a Redis token bucket with Postgres as the source of truth |
| Any real scale | Single Postgres for both writes and reporting | Split OLTP from reporting; stream audit events to WORM object storage for the 7-year tier |
| Regulatory | Hash chain verification is O(n) | Merkle tree with signed checkpoints (immudb / Trillian as reference implementations) |
