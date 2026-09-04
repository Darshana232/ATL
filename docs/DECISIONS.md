# Architecture Decision Log

Every significant decision, why it was made, what was rejected, and what would
change in production. Append-only: to reverse a decision, add a new entry that
supersedes the old one rather than editing history.

Status values: `accepted` · `superseded by ADR-XXXX` · `proposed`

---

## ADR-0001 — TypeScript across the whole stack
**Date:** 2026-09-04 · **Status:** accepted

**Decision.** One language for the API, the dashboard, the agent runtime and
all tests.

**Context.** The research documents assumed Python/FastAPI + React. The builder
is a first-year CS student building under buildathon time pressure.

**Alternatives considered.** Python/FastAPI + React/TS (as the research
proposed); Go for the API.

**Reasoning.** The dominant hidden cost for a single learner is context
switching between two ecosystems, toolchains and idiom sets. One language buys
roughly a full phase of extra progress. TypeScript additionally *teaches*
domain modelling: `type Verdict = 'PASS' | 'FLAG' | 'BLOCK'` makes illegal
states unrepresentable, which is directly useful for the policy engine. Both
the MCP SDK and the Anthropic SDK are first-class in TypeScript.

**Tradeoff.** Python is the better environment for data/ML work. We accept that
because ATL-India is deliberately rule-based, not ML-based — see ADR-0008.

**Production implication.** None serious. Node handles this workload well; a
real payment aggregator would likely run the policy engine in Go or Rust for
tail-latency control, behind the same HTTP contract.

---

## ADR-0002 — Separate API service from the dashboard
**Date:** 2026-09-04 · **Status:** accepted

**Decision.** Two deployables: a Fastify API (`apps/api`) and a Next.js
dashboard (`apps/dashboard`, Phase 9). The dashboard calls the API over HTTP.

**Alternatives considered.** A single Next.js app using route handlers for
everything.

**Reasoning.** The API *is* the product — the thing a payment aggregator would
actually operate and sell. Keeping it separate also makes a security property
real rather than diagrammatic: the agent runtime lives outside the trust
boundary and can only reach the policy engine across a network hop with its own
authentication.

**Tradeoff.** Two processes to run and deploy, and CORS to configure.

**Production implication.** Correct shape already. Would scale to N API
instances behind a load balancer with no redesign.

---

## ADR-0003 — npm workspaces instead of pnpm
**Date:** 2026-09-04 · **Status:** accepted

**Decision.** Use npm workspaces.

**Context.** `corepack enable pnpm` failed with `EACCES` because
`/usr/local/bin` is root-owned, and we declined to run `sudo` on the
developer's machine as a side effect of project setup.

**Alternatives considered.** `sudo corepack enable pnpm`; installing pnpm to a
user-local directory and editing shell `PATH`; the standalone install script
(`curl | sh`, rejected — piping a remote script to a shell unreviewed).

**Reasoning.** npm 11 was already installed and supports workspaces natively.
pnpm's real advantages — disk deduplication, strict peer isolation, install
speed — matter most in large multi-team monorepos, not for one developer.

**Tradeoff.** Slower installs, and npm's flat `node_modules` permits accidental
imports of transitive dependencies that pnpm would block.

**Production implication.** Swap to pnpm any time; only lockfile and CI change.

---

## ADR-0004 — Homebrew PostgreSQL locally; docker-compose committed but unexercised
**Date:** 2026-09-04 · **Status:** accepted

**Decision.** Run `postgresql@16` via Homebrew for local development. Keep
`docker-compose.yml` in the repo, explicitly labelled as not yet exercised on
the primary development machine.

**Context.** Docker was not installed. Installing Docker Desktop meant a ~1 GB
download, admin rights and a background daemon before writing any code.

**Alternatives considered.** Docker Desktop; Neon (managed cloud Postgres).
Neon was rejected for local development because every query becomes a network
round trip (~50–200 ms vs ~1 ms) and a bad network day would break both the dev
loop and a live demo.

**Tradeoff.** We lose environment reproducibility — the exact problem Docker
solves. Acceptable with one developer; the committed compose file preserves the
path for teammates and CI.

**Production implication.** Managed Postgres (Neon/RDS/Cloud SQL) in Phase 12.
`DATABASE_URL` is the only thing that changes.

---

## ADR-0005 — PostgreSQL, not a document database
**Date:** 2026-09-04 · **Status:** accepted

**Decision.** PostgreSQL 16 as the single datastore.

**Reasoning.** This system's core guarantees are relational and transactional:
foreign keys between mandate → decision → payment → audit event, `CHECK`
constraints as last-line invariant enforcement, serialisable transactions for
velocity counting, role-level `REVOKE` plus triggers for append-only audit
tables, and `JSONB` where genuinely schemaless payloads occur. A document
database provides none of the first four.

**Alternatives considered.** MongoDB (rejected: no foreign keys, weaker
constraint model); Postgres + Redis (deferred — Postgres handles velocity
counting correctly and fast enough at MVP volume, and adding Redis introduces a
second source of truth for a *security* limit, which is a genuinely bad trade).

**Production implication.** Audit tables get time-partitioned; read replicas
serve the dashboard; the 7-year retention tier moves to WORM object storage.

---

## ADR-0006 — Hand-written SQL migrations with checksums, not ORM schema sync
**Date:** 2026-09-04 · **Status:** accepted

**Decision.** Numbered `.sql` files applied by our own ~100-line runner. Each
runs in a transaction, is recorded with a SHA-256 checksum, and is guarded by a
`pg_advisory_lock`. Editing an already-applied migration is a hard error.

**Alternatives considered.** Prisma `migrate`/`db push`; Drizzle Kit
auto-generation; TypeORM `synchronize: true` (rejected outright — silent schema
mutation).

**Reasoning.** In a system whose entire value proposition is auditability, "the
schema is whatever the ORM inferred" is indefensible. Writing SQL by hand means
indexes and constraints are deliberate and reviewable. The checksum mechanism is
also a deliberate rehearsal of the Phase 6 audit hash chain: append-only history
plus hash-based tamper detection, at a smaller scale.

**Tradeoff.** No automatic down-migrations. Accepted: rolling *forward* is
standard practice in production anyway, since a down-migration that discards
data is rarely the recovery you actually want.

---

## ADR-0007 — Schema conventions: prefixed text IDs, TIMESTAMPTZ, TEXT+CHECK
**Date:** 2026-09-04 · **Status:** accepted

**Decision.**
1. Prefixed text primary keys (`mer_bigbasket`, later `mnd_`, `dec_`, `pay_`).
2. `TIMESTAMPTZ` everywhere, never `TIMESTAMP`.
3. `TEXT` + `CHECK (col IN (...))` for enumerations, not Postgres `ENUM`.

**Reasoning.**
1. Self-describing in logs; passing a merchant ID where a mandate ID belongs
   becomes visibly wrong rather than a silent integer mix-up. Matches Razorpay
   (`pay_`, `order_`) and Stripe conventions. Bare `BIGSERIAL` also leaks row
   counts.
2. `TIMESTAMP` carries no timezone, so a stored value is ambiguous —
   unacceptable in a record a regulator or dispute process may read. **The
   research documents specify `TIMESTAMP` throughout; that is a defect we are
   not carrying forward.**
3. Adding a status becomes a one-line migration; `ALTER TYPE` is awkward and
   removing an `ENUM` value is genuinely painful.

---

## ADR-0008 — The LLM proposes; a deterministic engine authorizes
**Date:** 2026-09-04 · **Status:** accepted · **This is the central decision.**

**Decision.** No language model ever has authority over whether a payment is
permitted. The agent may only *request* authorization. A pure, deterministic,
side-effect-free policy engine decides, and the payment service refuses to
capture money without a single-use signed voucher minted by that engine.

**Reasoning.** Trust must be a property of the architecture, not of model
quality. A better model does not make agentic payments safe; a payment path the
model cannot reach does. Concretely, this means a fully prompt-injected agent
still cannot move money — it can only ask, and asking goes through code it does
not control. It also makes decisions reproducible and explainable: the same
inputs always produce the same verdict and the same stated reason, which is what
"explainability" has to mean in a compliance context.

**Where the LLM *is* allowed.** Parsing natural-language intent into a
structured proposal; formulating catalog queries; ranking and selecting products
with a stated rationale; drafting human-readable prose *about* decisions already
made; summarising reports. All of these are proposals or presentation, never
authority.

**Alternatives considered.** LLM-as-judge over the mandate (rejected:
non-deterministic, unexplainable, prompt-injectable, and unauditable);
ML risk scoring as the gate (rejected: that is fraud detection, a different
problem — see ADR-0010).

**Production implication.** The voucher becomes a short-lived asymmetrically
signed capability token with keys in an HSM/KMS. The architecture does not
change.

---

## ADR-0009 — All external services behind adapters; Razorpay test mode deferred
**Date:** 2026-09-04 · **Status:** accepted

**Decision.** `PaymentProvider` interface with two implementations:
`MockUpiProvider` (default, deterministic, clearly labelled SIMULATED) and
`RazorpayTestProvider` (real Razorpay test-mode APIs). Same pattern for
`RiskProvider`, `CatalogProvider`, `NotificationProvider`.

**Context.** Razorpay test-mode keys were not available at Phase 1. Razorpay's
agentic-payments product is a live pilot with no public developer API for agent
mandates, so the *mandate rail* must be simulated regardless.

**Reasoning.** Nothing blocks on credentials, and the day test keys exist the
real provider drops in behind an unchanged interface. Honest labelling in the UI
and docs is mandatory — a simulated rail presented as a real integration would
be exactly the kind of claim `Claude/CLAUDE.md` §33 forbids.

---

## ADR-0010 — Mock risk provider; fraud detection is explicitly out of scope
**Date:** 2026-09-04 · **Status:** accepted

**Decision.** `RiskProvider` returns a score 0–100 with reasons. The only
implementation is `MockRiskProvider`. Risk is an **advisory input** that can
raise a `FLAG`; it can never override a deterministic `BLOCK` or manufacture a
`PASS`.

**Context.** The research refers to "AFRI" as a fraud-detection service. AFRI
does not exist — it is a proposal document in the same research folder. There is
no code and no endpoint.

**Reasoning.** Authorization ("was this permitted?") and fraud detection ("was
this suspicious?") are different problems with different correctness criteria.
Authorization must be deterministic and explainable; fraud detection is
probabilistic and empirical. Merging them would make our verdicts unexplainable
and our fraud detection untestable.

---

## ADR-0011 — Fail-fast configuration; secrets never logged
**Date:** 2026-09-04 · **Status:** accepted

**Decision.** `apps/api/src/config.ts` is the only module permitted to read
`process.env`. It validates everything with Zod at startup, reports all
problems at once, returns a frozen object, and refuses to boot in production
without `VOUCHER_SIGNING_SECRET`. Error messages name the variable and the
violated rule but never echo the received value. `describeConfig()` reduces
secrets to booleans for startup logging, and pino redacts sensitive paths
centrally.

**Reasoning.** Converts an entire category of runtime mystery into a startup
error with a readable message. The no-echo rule is enforced by tests, because a
config error that prints a secret writes it into terminals, CI logs and
screenshots. Central log redaction is also a genuine DPDP data-minimisation
control and becomes evidence in the Phase 10 register.

---

## ADR-0013 — Use Razorpay's public IFSC API; hand-seed the catalog
**Date:** 2026-09-04 · **Status:** accepted

**Decision.** Adopt `https://ifsc.razorpay.com/{IFSC}` (keyless, Razorpay-
operated) for seed-time bank fixtures and for cold-path IFSC validation during
mandate creation. **Never** call it — or any third-party API — inside the
authorization path. Hand-seed the product catalog rather than integrating a
fake-store API.

**Context.** Evaluated `github.com/public-apis/public-apis` (MIT, 1,748
entries). Full tiering in [`EXTERNAL_APIS.md`](EXTERNAL_APIS.md).

**Reasoning.**
- IFSC is a real Razorpay public API, needs no key, and returns a per-branch
  `UPI` eligibility flag — real Indian bank and VPA-handle data instead of
  invented strings, and an honest "we use the public Razorpay API where one
  exists" claim.
- The hot-path prohibition is the important half. A compliance verdict must not
  depend on someone else's uptime: if the dependency is down, blocking every
  payment and allowing every payment are both wrong answers.
- DummyJSON and FakeStoreAPI work and need no key, but price in USD, list US
  consumer goods, and carry **no MCC**. Our category rules key on ISO 18245
  MCCs. Hand-seeded Indian grocery/food fixtures are more realistic *and* have
  no network dependency.

**Also recorded:** three of seven listed APIs tested were stale — one dead, one
serving HTML instead of JSON, one now requiring a key while still advertised as
keyless. A community directory is a discovery tool, not a source of truth.

---

## ADR-0012 — Split liveness and readiness health checks
**Date:** 2026-09-04 · **Status:** accepted

**Decision.** `GET /v1/health/live` touches no dependencies and always returns
200. `GET /v1/health` queries Postgres and returns 503 when it cannot.

**Reasoning.** The two answers have opposite consequences: failing liveness
means *restart me*; failing readiness means *stop sending me traffic but leave
me alive*. Conflating them produces a well-known outage — the database blinks,
every instance fails its health check, the orchestrator restarts all of them,
and a database that was recovering now faces a thundering herd of reconnects.

**Production implication.** Wire `live` to the container liveness probe and
`/v1/health` to the readiness probe and load-balancer target group.
