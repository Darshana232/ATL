# Phase 1 — Foundation

**Status:** ✅ done · **Commits:** `0d4e40b`, `f63f6ed`, `70c5e4f`, `1cfd444`,
`714f4da`

---

## What it is

The boring, load-bearing parts of a service: how it reads its settings, how it
logs, how it talks to the database, how the schema is applied, and how it
starts and stops.

## Why it comes here

Every later phase writes code that *depends* on these. Retrofitting config
validation or log redaction into a system that already has forty files is a
week of work; doing it first is an afternoon.

> **Analogy.** Wiring and plumbing before furniture. Nobody photographs it, and
> you cannot fix it later without breaking walls.

## The steps

**1. Fail-fast typed configuration** — `config.ts`
The *only* module allowed to read `process.env`. Validates everything with Zod
at startup, reports **all** problems at once (not one per restart), returns a
frozen object, and refuses to boot in production without a voucher signing
secret. Error messages name the variable and the violated rule but **never echo
the value** — enforced by a test, because a config error that prints a secret
writes it into terminals, CI logs and screenshots.
One subtle catch handled: an `.env` line like `ANTHROPIC_API_KEY=` produces the
string `''`, not `undefined`. Without special handling, `.optional()` accepts it
and the failure surfaces much later as a confusing 401.
→ 18 tests.

**2. Structured logging with central redaction** — `logger.ts`
pino, JSON output, ISO timestamps, and one central list of sensitive paths that
get redacted. Central rather than per-call-site, because a redaction rule you
have to remember at every call site is a rule that will be forgotten. This is
also a genuine DPDP data-minimisation control and becomes evidence in the
Phase 8 compliance register.

**3. A budgeted connection pool** — `db/pool.ts`
A deliberate maximum size, connection and statement timeouts, and recovery from
idle-connection errors. Postgres has a hard `max_connections`; a pool that grows
without a budget doesn't fail gracefully, it fails everywhere at once.
→ [connection pooling](../concepts/database/09_connection-pooling.md)

**4. A checksummed migration runner** — `db/migrate.ts`
Numbered `.sql` files, applied by ~180 lines of our own code. Each runs **in a
transaction**, is recorded with a **SHA-256 checksum**, and is guarded by a
**`pg_advisory_lock`** so two instances booting simultaneously cannot both apply
it. Editing an already-applied migration is a hard error.
This is a deliberate rehearsal of the Phase 6 audit hash chain: append-only
history plus hash-based tamper detection, at a smaller scale.

**5. Health endpoints, error handling, graceful shutdown** — `routes/health.ts`,
`server.ts`, `index.ts`
Two endpoints, deliberately different:
- `GET /v1/health/live` — touches nothing, always 200. Failing means *restart me*.
- `GET /v1/health` — queries Postgres, returns 503 when it can't. Failing means
  *stop sending me traffic but leave me alive*.

Conflating them produces a well-known outage: the database blinks, every
instance fails its check, the orchestrator restarts them all, and a database
that was recovering now faces a thundering herd of reconnects.
Plus request IDs on every request, a 404 handler, and an error handler proven by
a test that a 500 response leaks **no stack trace and no connection string**.
→ 7 tests.

## What you can do after it

`npm run dev`, hit `/v1/health`, see structured JSON logs with a request id, and
watch it refuse to start when you break `DATABASE_URL` — with a message that
tells you exactly what's wrong.

## Concepts it teaches

- [Configuration and fail-fast](../concepts/backend/07_configuration-and-fail-fast.md)
- [Structured logging and redaction](../concepts/backend/08_structured-logging-and-redaction.md)
- [Error handling and information disclosure](../concepts/backend/09_error-handling-and-information-disclosure.md)
- [Liveness vs readiness](../concepts/backend/10_health-checks-liveness-vs-readiness.md)
- [Graceful shutdown](../concepts/backend/12_graceful-shutdown.md)
- [Migrations and schema as code](../concepts/database/06_migrations-and-schema-as-code.md)
- [Connection pooling](../concepts/database/09_connection-pooling.md)

## The honest gap

No CI runs any of this yet, and there is no linter. Both land in Phase 9.
