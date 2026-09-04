# ATL-India — Agentic Trust & Compliance Layer

An authorization, evidence and compliance layer for **AI-agent-initiated
payments** on Indian rails.

> **Honest scope.** This is a buildathon MVP with a **Razorpay-inspired
> architecture**. It is not Razorpay infrastructure, it is not connected to
> NPCI, it is not certified by anyone, and it does not file reports with any
> regulator. Every simulated component is labelled as such — in the code, in
> the UI, and in [`docs/RESEARCH_REALITY_CHECK.md`](docs/RESEARCH_REALITY_CHECK.md).

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

**Phase 1 of 12 complete.** Foundation: validated configuration, structured
logging, PostgreSQL pool, checksummed migration runner, health endpoints,
25 passing tests. See [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md).

---

## Quick start

**Prerequisites:** Node ≥ 22, PostgreSQL 16, macOS with Homebrew (or Docker —
see below).

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

# 3. Install, migrate, run
npm install
npm run migrate
npm run dev

# 4. Verify
curl localhost:8080/v1/health
```

Expected:

```json
{"status":"ok","version":"0.1.0","uptimeSeconds":0,
 "checks":{"database":"ok","databaseLatencyMs":0.63}}
```

**Commands**

| Command | What it does |
|---|---|
| `npm run dev` | Start the API with hot reload |
| `npm test` | Run every test |
| `npm run typecheck` | Type-check without emitting |
| `npm run migrate` | Apply pending migrations (idempotent) |
| `npm run db:start` / `db:stop` | Start/stop Postgres (Homebrew) |
| `npm run db:psql` | Open a psql shell on the dev database |

Docker users: `docker compose up -d db`, then set `DATABASE_URL` to
`postgres://atl:atl_dev_only@localhost:5432/atl_india_dev`. Note this path is
committed but **not yet exercised** — see [ADR-0004](docs/DECISIONS.md).

---

## Layout

```
apps/api/          Fastify API: authorization, policy engine, audit trail
apps/dashboard/    Next.js dashboard                          (Phase 9)
packages/core/     Pure domain logic: rules, hash chain        (Phase 4)
docs/              Architecture, decisions, learning log
Claude/CLAUDE.md   Engineering and teaching protocol for this project
Research/          Source strategy material (see the reality check first)
```

## Documentation

| File | Contents |
|---|---|
| [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md) | **Start here.** Phase status, what exists, what is next |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Architecture decision log (ADR-0001 …) |
| [`docs/RESEARCH_REALITY_CHECK.md`](docs/RESEARCH_REALITY_CHECK.md) | Verified vs. corrected vs. unverified claims |
| [`docs/LEARNING_LOG.md`](docs/LEARNING_LOG.md) | Concepts, mistakes and study path per phase |

---

## What is real and what is simulated

| Component | Status |
|---|---|
| Policy engine, audit chain, authorization API, dashboard | **Real** |
| Agent runtime | **Real** (real LLM, real tool calling) |
| Payment capture | **Adapter**: `MockUpiProvider` (default) / `RazorpayTestProvider` (real test mode) |
| Mandate rail | **Simulated** — NPCI UAP has no public specification |
| Product catalog | **Simulated** — seeded fixtures |
| Fraud risk scores | **Mocked** — the "AFRI" service in the research does not exist |

The audit trail is **tamper-evident**, not tamper-proof: a hash chain *detects*
modification; it cannot prevent a database superuser from rewriting the whole
chain. Signed checkpoints raise that bar without eliminating it.

## License

UNLICENSED — private buildathon project.
