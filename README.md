# ATL-India — Agentic Trust & Compliance Layer

An authorization, evidence and compliance layer for **AI-agent-initiated
payments** on Indian rails.

> **Honest scope.** This is a buildathon MVP with a **Razorpay-inspired
> architecture**. It is not Razorpay infrastructure, it is not connected to
> NPCI, it is not certified by anyone, and it does not file reports with any
> regulator. Every simulated component is labelled as such — in the code, in
> the UI, and in [`docs/RESEARCH_REALITY_CHECK.md`](docs/RESEARCH_REALITY_CHECK.md).

> ### ⚠️ About the `Research/` folder — read before quoting anything from it
>
> `Research/` is **input material, not findings**. It is committed for
> provenance so the corrections applied to it are traceable — **not** because
> it is accurate.
>
> Specifically, it contains:
>
> - **Quotes attributed to named companies that appear to be fabricated**,
>   including a "Bigbasket Compliance Lead" and a "Payment Processor Compliance
>   Officer". No merchant interviews took place. These are **not** real
>   statements by those organisations or by anyone at them.
> - **Document bylines such as "Razorpay Compliance & Product Team" and
>   "Razorpay Founder".** These are not authored by Razorpay. This project has
>   no affiliation with, endorsement from, or relationship to Razorpay, NPCI,
>   BigBasket, Zomato, Swiggy, Zepto or any other company named in it.
> - **Revenue projections, market sizing and regulatory claims that are
>   unverified or wrong.** Several are demonstrably incorrect.
>
> Every one of these is itemised, with corrections and sources, in
> [`docs/RESEARCH_REALITY_CHECK.md`](docs/RESEARCH_REALITY_CHECK.md). **Read
> that file before citing anything from `Research/`.**
>
> Company names appearing in seed fixtures (`apps/api/src/db/seed.ts`) are
> illustrative test data only. Merchants in restricted categories use invented
> names deliberately.

---

## The problem

An AI agent can now spend real money on UPI. NPCI, Razorpay and OpenAI launched
a live agentic-payments pilot on ChatGPT in Oct 2025 built on **UPI Reserve Pay
+ UPI Circle**; Razorpay and NPCI extended it to Claude in Feb 2026.

When a human pays, the authorization *is* the human — they saw the amount and
entered their UPI PIN. When an agent pays, that link breaks: the user authorized
a **policy** ("groceries, ₹5,000, this week, BigBasket only"), not a
transaction. Three questions then have no infrastructure answer:

1. **Authorization** — was this specific charge inside what the human permitted?
2. **Evidence** — can you prove it later, in a form nobody could have edited
   after the fact?
3. **Explanation** — when it is blocked, can the merchant, the user and a
   compliance officer all understand *why*?

That gap is not fraud detection (probabilistic, "was this bad?"). It is
**authorization and evidence** (deterministic, provable, "was this permitted,
and can you prove what happened?").

## The thesis

> **The LLM proposes. A deterministic engine authorizes. An append-only,
> hash-chained log proves it. Nobody has to trust the model.**

The load-bearing consequence: on `PASS`, the policy engine mints a **single-use,
short-lived signed voucher**, and the payment service refuses to capture money
without one. So even a fully prompt-injected agent cannot move money — it can
only *ask*, and asking goes through code it does not control. See
[ADR-0008](docs/DECISIONS.md).

---

## Status

**All nine phases complete.** 671 tests, 11 migrations, two workspaces.
See [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md).

| Phase | | |
|---|---|---|
| 1 | Foundation — config, logging, pool, migrations, health | ✅ |
| 2 | Schema, least-privilege role, seed fixtures | ✅ |
| 3 | Mandate domain, DTOs, repository, audit writer, API | ✅ |
| 4 | Deterministic policy engine | ✅ |
| 5 | Authorization API — Ed25519, idempotency, vouchers | ✅ |
| 6 | Hash-chain verification, signed checkpoints, tamper demo | ✅ |
| 7 | Payments, webhooks, agent runtime, MCP, injection test | ✅ |
| 8 | Console and the three compliance reports | ✅ |
| 9 | RBAC, rate limits, threat model, lint, CI | ✅ |

### See it in one command

```bash
npm run demo
```

Seven acts on a real socket with real signatures: a mandate is granted, an
agent shops inside it, the same agent asks for too much and is refused **with
the numbers**, the agent is **prompt-injected, obeys completely, and still
cannot pay**, the evidence chain verifies, a privileged insider tampers and the
chain notices, and the compliance reports state their own gaps.

Other demos: `npm run demo:authorize`, `npm run demo:tamper`,
`npm run demo:agent`.

---

## Quick start

**Prerequisites:** Node ≥ 22, PostgreSQL 16, macOS with Homebrew.

```bash
# 1. Database
brew install postgresql@16
brew services start postgresql@16
/opt/homebrew/opt/postgresql@16/bin/createdb atl_india_dev

# 2. Configuration
cp .env.example .env
#    then set DATABASE_URL to postgres://$(whoami)@localhost:5432/atl_india_dev
#    and generate a voucher secret:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Install, migrate, seed
npm install
npm run migrate
npm run seed

# 4. The whole story in one command
npm run demo

# 5. Or run the services
npm run dev:api          # http://127.0.0.1:8080
npm run dev:dashboard    # http://127.0.0.1:3000
```

The console needs its own config:

```bash
cp apps/dashboard/.env.example apps/dashboard/.env.local
#   set ATL_ADMIN_KEY to the ADMIN_API_KEY from the repo-root .env
```

Then sign in at `/login` with a seeded operator —
`admin@atl.example`, `compliance@atl.example` or `viewer@atl.example`
(passwords are in `apps/api/src/db/seed.ts`; they are development fixtures in a
script production never runs).

Expected:

```json
{"status":"ok","version":"0.1.0","uptimeSeconds":0,
 "checks":{"database":"ok","databaseLatencyMs":0.63}}
```

**Commands**

| Command | What it does |
|---|---|
| `npm run demo` | **The whole story**, seven acts, real HTTP |
| `npm run demo:authorize` | Authorization scenarios and a tamper attempt |
| `npm run demo:tamper` | Break the audit chain on purpose, and detect it |
| `npm run demo:agent` | The agent loop, including prompt injection |
| `npm run dev:api` / `dev:dashboard` | Run a service with hot reload |
| `npm run mcp` | MCP server over stdio |
| `npm run check` | typecheck + lint + every test |
| `npm test` / `typecheck` / `lint` | Individually |
| `npm run migrate` / `seed` | Apply migrations (idempotent) / load fixtures |
| `npm run db:start` / `db:stop` / `db:psql` | Postgres (Homebrew) |

`docker-compose.yml` is committed and **has still never been run** — Docker is
not installed on the development machine. CI covers the same risk by applying
every migration to an empty `postgres:16` container. See
[ADR-0004](docs/DECISIONS.md) and ADR-0024.

---

## Layout

```
apps/api/src/
  policy/        THE PRODUCT. 13 pure rules, no clock, no database, no LLM
  auth/          Ed25519 request signing; scrypt passwords; sessions
  voucher/       the single-use capability token that lets money move
  audit/         canonical JSON, hash chain, verifier, signed checkpoints
  agent/         tool registry, executor, LLM adapter, THE INJECTION TEST
  reports/       FREE-AI coverage, STR drafts, DPDP register
  providers/     payment, catalog, risk, bank lookup — all behind adapters
  routes/        authorize, payments, webhooks, audit, reports, console, auth
  db/migrations/ 11 hand-written, checksummed, immutable once applied
  demo/          four runnable demonstrations
  mcp/           MCP server over the same tool registry
apps/dashboard/  Next.js console: 11 screens
docs/            architecture, decisions, threat model, performance
Understanding/   why each phase was built the way it was, and what went wrong
Research/        source material — read the reality check FIRST
```

## Documentation

| File | Contents |
|---|---|
| [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md) | **Start here.** Phase status, what exists, what is next |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Architecture decision log (ADR-0001 …) |
| [`docs/RESEARCH_REALITY_CHECK.md`](docs/RESEARCH_REALITY_CHECK.md) | Verified vs. corrected vs. unverified claims |
| [`docs/SECURITY.md`](docs/SECURITY.md) | What we claim, precisely, and what we do not |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | STRIDE, each mitigation naming its test, plus **accepted risks** |
| [`docs/API.md`](docs/API.md) | Every endpoint, with the signing scheme |
| [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) | `EXPLAIN ANALYZE` on the hot paths |
| [`docs/LEARNING_LOG.md`](docs/LEARNING_LOG.md) | Concepts, mistakes and study path per phase |
| [`Understanding/`](Understanding/) | One file per phase: what was built, why, and what went wrong |

---

## What is real and what is simulated

| Component | Status |
|---|---|
| Policy engine, audit chain, authorization API, console, reports | **Real** |
| Agent runtime, MCP server, tool-level authorization | **Real** — real tool calling; Claude API when a key is set, deterministic mock otherwise |
| Operator auth, RBAC, rate limiting | **Real** |
| Payment capture | **Adapter**: `MockUpiProvider` (default, labelled SIMULATED) / `RazorpayTestProvider` — real test-mode API, **never yet run against it** (no test keys) |
| Mandate rail | **Simulated** — Razorpay's agentic-payments product is a live pilot with no public developer API |
| Product catalog | **Simulated** — hand-seeded Indian fixtures with real ISO 18245 MCCs |
| Fraud risk scores | **Simulated** — invented heuristics. The "AFRI" service in the research **does not exist** |

### The claim ceilings, in one place

- The audit trail is **tamper-evident**, never tamper-proof. A hash chain
  *detects* modification; it cannot prevent a database superuser who also holds
  the checkpoint secret from rewriting history.
- The compliance reports state **control coverage** (currently **22/26**, with
  the four gaps named on screen), never a compliance percentage. FREE-AI is a
  committee framework with no certifying authority.
- STR output is a **DRAFT for human review**. FIU-IND filing runs through
  FINnet by registered reporting entities. We are not one, and the schema has
  no `filed` state to set.
- **No merchant interviews have taken place.** This is printed as gap
  `ATL-C26` in the coverage report rather than omitted.

[`docs/SECURITY.md`](docs/SECURITY.md) states each claim precisely;
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) lists the **accepted risks**.

## License

UNLICENSED — private buildathon project.
