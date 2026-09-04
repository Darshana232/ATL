# Phase 1 — Foundation

**Status:** DONE · **Started:** 2026-09-04 · **Finished:** 2026-09-04
**Result:** 25 tests passing, `tsc` clean, service boots and shuts down cleanly.

---

## 1. What we are building

A service that starts, refuses to start when misconfigured, connects to
PostgreSQL, applies its own schema migrations, answers two health endpoints, and
has tests. No business logic at all — the skeleton every later phase hangs off.

## 2. Why now

Every later phase writes to this database and is tested against this harness. If
configuration, migrations or the test setup are shaky, every subsequent phase
inherits the shakiness — and I would end up debugging Phase 1 problems while
trying to build the hash chain in Phase 6.

Doing it *later* is worse for a specific reason: retrofitting fail-fast
configuration and dependency injection into code that already reads
`process.env` inline means touching every file.

Doing it *earlier* is not possible — there is nothing earlier.

## 3. How it works

```
npm run dev
   │
   ├─ loadEnvFile()      reads repo-root .env into process.env
   │                     (dotenv never overwrites an existing var, so real
   │                      environment variables win — which is what production
   │                      needs, since it ships no .env at all)
   │
   ├─ loadConfig()        Zod parses process.env -> frozen typed Config
   │                      invalid? throw ConfigError listing EVERY problem
   │                      and exit. Never boot half-configured.
   │
   ├─ createLogger()      pino: JSON, ISO timestamps, service+env on every
   │                      line, sensitive paths redacted centrally
   │
   ├─ createPool()        one pg Pool: max 10, 5s connection timeout,
   │                      'error' handler so a dead idle client cannot
   │                      crash the process
   │
   ├─ checkDatabase()     SELECT 1 — prove it answers, or exit(1).
   │                      An authorization service that cannot read mandates
   │                      must not accept traffic.
   │
   ├─ buildServer(deps)   Fastify: request ids, 404 handler, error handler
   │
   ├─ app.listen()        127.0.0.1 in development, not 0.0.0.0
   │
   └─ SIGTERM/SIGINT      stop accepting -> drain -> close pool -> exit,
                          with a 10s hard timeout guard
```

**One real request** — `GET /v1/health`:

```
request in ──► Fastify assigns requestId (or reuses x-request-id)
           ──► handler starts a monotonic timer (process.hrtime.bigint)
           ──► checkDatabase(pool): SELECT 1
                    ok    ──► 200 {status:"ok", checks:{database:"ok",
                                    databaseLatencyMs: 0.63}}
                    throws ──► log the real error at level=error
                           ──► 503 {status:"degraded",
                                    checks:{database:"error"}}
                                    (no message, no host, no stack)
```

## 4. Concepts I need first

**Monorepo / workspaces.** One repository holding several packages, with one
`npm install` and one lockfile. `apps/api` and `apps/dashboard` can share
`packages/core` without publishing it anywhere.

**Fail-fast configuration.** Validate all input at startup and refuse to run if
anything is wrong. A service that boots with a missing secret and dies on
request #4,000 is strictly worse than one that never started: the failure is
delayed, is discovered by a user, and looks like something else.

**Connection pooling.** Establishing a Postgres connection costs a TCP handshake
plus authentication, roughly 5–15 ms. A pool keeps a few open and lends them
out, so that cost is paid at startup instead of per request. Our health check
reports 0.63 ms latency precisely because no handshake happens.

**Pool size is a cluster-wide budget.** Postgres enforces a hard
`max_connections` (default 100). Ten instances each configured `max: 100` demand
1,000 connections; Postgres refuses the excess — including your monitoring and
your `psql` session, exactly when you need them. The rule is
`instances × max ≤ max_connections − headroom`.

**Backpressure.** When the system is saturated, fail *fast and visibly* instead
of queueing without limit. `connectionTimeoutMillis: 5000` is backpressure: a
clear 503 beats a request that waits forever while memory climbs and sockets
leak.

**Migrations as append-only history.** Numbered SQL files applied in order,
exactly once, recorded in a table. Never edit `0001` after it has run anywhere —
add `0002`. Same discipline as the audit log, for the same reason: history you
can rewrite is not history.

**Liveness vs readiness.** *Liveness*: is the process responsive? *Readiness*:
can this instance serve traffic? Failing liveness means **restart me**; failing
readiness means **stop sending me traffic but leave me alive**.

**Unit vs integration tests.** A unit test exercises a function in isolation
(our config parser needs no database). An integration test exercises components
together against real infrastructure — you *cannot* unit-test a `REVOKE` or a
`CHECK` constraint, because the behaviour lives in Postgres, not in our code.

## 5. Design choices & tradeoffs

| Choice | Alternative | Why | Cost |
|---|---|---|---|
| Fastify API separate from the dashboard | one Next.js app | the API *is* the product; the trust boundary becomes a real network hop | two processes to run and deploy |
| `loadConfig(env = process.env)` | read `process.env` inline | testable without mutating globals; one list of every input | ~60 lines |
| Zod for config | hand-written `if` checks | one schema yields runtime validation *and* the static type | a dependency |
| Frozen config object | plain object | later code cannot mutate config at runtime | none |
| Report all config errors at once | fail on the first | one restart fixes a batch of typos | slightly more code |
| Empty string → `undefined` | trust `.optional()` | `KEY=` in `.env` yields `''`, which `.optional()` accepts, surfacing later as an opaque 401 | a `preprocess` wrapper |
| Central pino `redact` by path | redact at each call site | one place to get right; new code inherits it | must maintain the path list |
| Own migration runner (~100 lines) | Prisma / Drizzle Kit | we write the SQL, so indexes and constraints are deliberate and reviewable; and it rehearses the Phase 6 hash chain | no auto down-migrations |
| Checksum applied migrations | filename tracking only | editing an applied migration is caught instead of silently diverging from git | none |
| `TIMESTAMPTZ` everywhere | `TIMESTAMP` (as the research specifies) | `TIMESTAMP` has no timezone, so a stored value is ambiguous — unacceptable in an audit record | none |
| `TEXT` + `CHECK` for status | Postgres `ENUM` | adding a value is a one-line migration; `ALTER TYPE` is awkward | marginally larger rows |
| Prefixed text IDs (`mer_bigbasket`) | `BIGSERIAL` | self-describing in logs; ID confusion becomes visible; `BIGSERIAL` also leaks row counts | slightly larger keys |
| Split liveness/readiness | one endpoint | avoids restart-storm-on-DB-blink | one more route |
| Refuse to boot if DB unreachable | boot and serve errors | an authorization service that cannot read mandates must not accept requests | dev needs Postgres running |
| Homebrew Postgres | Docker Compose | Docker was not installed; ~1 GB + admin + daemon before any code | environment not reproducible |
| npm workspaces | pnpm | `corepack` needed root; pnpm's wins are marginal solo | slower installs |

## 6. Files created/modified

```
apps/api/package.json, tsconfig.json, vitest.config.ts
apps/api/src/
  config.ts        + config.test.ts   (18 tests)
  logger.ts
  env-file.ts
  test-setup.ts
  server.ts
  index.ts
  db/pool.ts
  db/migrate.ts
  db/migrations/0001_init.sql         (merchants)
  routes/health.ts + health.test.ts   (7 tests)
root: package.json, .npmrc, tsconfig.base.json, .env.example, docker-compose.yml
```

## 7. How we test it

| Test | Asserts | Failure it prevents |
|---|---|---|
| defaults applied from minimal env | `NODE_ENV`/`PORT`/`LOG_LEVEL` defaults | "worked locally because I had extra vars set" |
| `PORT: '3000'` becomes number `3000` | coercion happens | `PORT + 1` producing `"30001"` |
| config object frozen | `Object.isFrozen`, mutation throws | code changing config at runtime |
| missing `DATABASE_URL` | throws, message names it | booting without a database |
| `mysql://` rejected | message says "PostgreSQL URL" | a cryptic protocol error deep in the driver |
| `PORT: 'abc'` / `'70000'` / `'0'` | throws | silent `NaN`, invalid port |
| unknown `LOG_LEVEL` | throws | a typo silently disabling logging |
| all problems reported together | message names three distinct fields | four restarts for four typos |
| `ANTHROPIC_API_KEY: ''` → `undefined` | empty means missing | an opaque upstream 401 in Phase 8 |
| whitespace-only → `undefined` | trimmed | same |
| production without voucher secret | throws | **deploying with a payment security control silently disabled** |
| secret shorter than 64 chars | throws | a weak HMAC key |
| **error message excludes the value** | `not.toContain(secret)` | writing secrets into terminals, CI logs, screenshots |
| `describeConfig` hides secrets | booleans only; no key material | leaking on the startup log line |
| `describeConfig` hides DB credentials | host present, `hunter2` absent | a password embedded in `DATABASE_URL` reaching logs |
| liveness 200 (DB up) | — | — |
| readiness 200, latency is a number | the query actually ran | a hardcoded `"ok"` |
| unknown route → structured 404 + requestId | shape and traceability | untraceable responses |
| caller `x-request-id` echoed | propagation | a trace that restarts at each service |
| liveness **still 200** with DB down | process vs dependency distinction | restart storms |
| readiness 503 with DB down | status code, not just body | traffic routed to a broken instance |
| **degraded body leaks nothing** | no `ECONNREFUSED`, host, username, stack | information disclosure on the least protected route |

Beyond the automated suite, three properties were verified by breaking them:

- **Migration tamper detection** — appended a comment to an applied migration;
  the runner refused with both checksums and exited non-zero; restored and it
  was accepted again (proving the restore was byte-exact).
- **`CHECK` constraints** — six invalid rows inserted in raw SQL, bypassing all
  application code: bad ID prefix, non-numeric MCC, three-digit MCC, invalid
  status, whitespace-only name, duplicate key. **All six rejected by Postgres.**
- **The security test itself** — deliberately leaked the database error into the
  health response and watched the test fail on `ECONNREFUSED`, then reverted.

That last one matters most: **a test you have never seen fail is not a test.**

## 8. Security notes

**Threat:** secrets leak through error messages.
**Vulnerability:** the natural way to write a validation error is "expected 64
chars, got `a7f3…`", which writes the secret into terminals, CI logs and any
screenshot of them.
**Mitigation:** error messages name the variable and the violated rule, never
the value. Enforced by a test.
**Why this one:** log scrubbing downstream is unreliable and after the fact; not
producing the string is absolute.

**Threat:** information disclosure via health endpoints.
**Vulnerability:** health endpoints are usually the least protected route in a
service. A driver error like `password authentication failed for user "atl"`
reveals a username, the driver, and that the endpoint reaches an internal
database.
**Mitigation:** log the real error, return only `{"database":"error"}`.
Enforced by a test asserting six separate absences.
**Why this one:** an attacker's first step is reconnaissance. Denying free
reconnaissance is cheap; the endpoint stays useful because *we* can read the log.

**Threat:** PII reaching logs.
**Vulnerability:** someone logs a whole request object "just for debugging", and
UPI VPAs and auth headers land in a log system with weaker access controls than
the database.
**Mitigation:** central pino `redact` on paths — `req.headers.authorization`,
`*.upiVpa`, `*.phone`, `*.token`, `*.signature`, and others.
**Why this one:** it is one place to get right, and all future code inherits it.
Also a genuine DPDP data-minimisation control, and evidence for Phase 10.

**Threat:** deploying with a security control disabled.
**Vulnerability:** `VOUCHER_SIGNING_SECRET` is optional in development, so a
production deploy could omit it and silently weaken payment authorization.
**Mitigation:** config refuses to boot when `NODE_ENV=production` and the secret
is absent.
**Why this one:** the failure is loud, immediate, and impossible to ignore.

**Threat:** exposing the dev server to the local network.
**Mitigation:** bind `127.0.0.1`, not `0.0.0.0`. Development machines sit on
café and campus wifi.

## 9. What happens at scale

| Volume | What breaks first | Fix |
|---|---|---|
| 10 merchants | nothing | — |
| 10k merchants | pool exhaustion once we run several instances | keep the cluster-wide budget; add PgBouncer for connection multiplexing |
| 10M transactions | `SELECT 1` is still trivial, but the readiness check becomes a load source at high probe frequency | cache readiness for ~1s; never let probes dominate DB traffic |
| Any real scale | migrations blocking deploys — a migration taking an `ACCESS EXCLUSIVE` lock stalls the application | separate schema migration from deploy; use `CREATE INDEX CONCURRENTLY`; add columns nullable first, backfill, then constrain |
| Any real scale | logs at volume: JSON to stdout is right, but 20 KB/request is not | sample debug logs, keep audit events (Zone 3) unsampled — they are evidence, not telemetry |

The last row is a genuine architectural distinction that starts here: **logs are
observability and may be sampled or dropped; audit events are evidence and may
never be.** Different durability requirements, different storage, different
retention.

## 10. What I learned

- **The empty-string trap.** `KEY=` in a `.env` gives `''`, not `undefined`, so
  `.optional()` accepts it. This would have cost hours in Phase 8 as an
  unexplained 401.
- **Pool size is a shared budget**, not a local tuning knob. This is one of the
  most common ways teams take down their own database.
- **An unhandled `'error'` event terminates a Node process.** Three lines of
  handler is the difference between "the database restarted" and "the API died".
- **`TIMESTAMPTZ` vs `TIMESTAMP`** is not pedantry. A timestamp without a zone
  in a payment audit record is ambiguous evidence.
- **`CHECK` constraints are the last line of defence** — proven by attacking the
  table directly in SQL. Application validation protects against accidents; the
  schema protects against everything, including me with a `psql` prompt.
- **Postgres has transactional DDL.** A failed migration leaves no partial
  schema. MySQL and Oracle do not offer this, which is why migrations there are
  riskier.
- **A transaction lives on one connection.** `pool.query()` may hand out a
  different connection each call, so `BEGIN` on one and `COMMIT` on another does
  nothing at all. This is a bug you would not notice until data was wrong.
- **Liveness ≠ readiness**, and conflating them turns a database blink into a
  restart storm.
- **Status codes are a machine contract.** A load balancer reads `503`; it never
  parses `{"status":"degraded"}`.
- **Derive types from values.** `ReturnType<typeof pino>` beats guessing which
  type name a library exports, and stays correct when they reorganise.
- **A test you have never seen fail is not a test.**
- **An empty command output is not a pass.** Check exit codes.

## 11. Mistakes made & why

**1. Assumed pnpm would install.** `corepack enable pnpm` failed `EACCES` —
`/usr/local/bin` is root-owned. *Why:* I planned the toolchain without checking
it. *Lesson:* audit the environment before designing around it. Twenty seconds
of `which` would have saved the detour. (→ ADR-0003)

**2. Assumed Docker was installed.** It was not, and the Phase 1 plan named
"Docker Compose Postgres" as a deliverable. *Why:* same root cause as #1 — a
plan written from habit rather than from the machine in front of me.
*Lesson:* environment assumptions are assumptions. (→ ADR-0004)

**3. Used `$PIPESTATUS` in zsh.** It is a bash array; zsh spells it
`$pipestatus`. The command printed nothing, which briefly *looked* like "tsc
produced no output, therefore it passed" — when in fact nothing had been
measured. *Lesson:* the most dangerous test result is the one that silently
measures nothing.

**4. Fought TypeScript over Fastify's logger generic.** Passing a concrete
`pino.Logger` as `loggerInstance` specialised the whole `FastifyInstance` type,
so it stopped matching `FastifyInstance` with default generics — and the broken
inference cascaded, degrading the error handler's `error` parameter to
`unknown`. Four errors, one of them 20 lines long, from one root cause. Fixed by
upcasting to Fastify's own `FastifyBaseLogger` (pino's type is strictly richer,
so widening is safe). *Lesson:* read the **last** line of a long TypeScript
error — it names the actual incompatibility. And when a library is generic over
something you pass in, expect that specialisation to propagate everywhere.

**5. Quoted a whole command into a shell variable.** `PSQL="psql -d db -X"`
then `$PSQL -c '...'` fails in zsh, which does not word-split unquoted
variables the way bash does. *Lesson:* put directories on `PATH`; do not stuff
commands-with-arguments into variables.

**Pattern across all five:** four of them are *assumption* failures, not
knowledge failures. I knew all the relevant facts; I did not check which applied
here. That is the actual skill gap to work on.

## 12. Open questions / debt

- **`startedAt` is set in `buildServer()`**, so `uptimeSeconds` measures server
  build time rather than process start. Off by milliseconds and harmless, but
  the label is slightly wrong. `performance.timeOrigin` would be exact.
- **No linter.** ESLint + Prettier not configured. Deliberate for now; churn
  during Phases 2–4 would mean re-formatting constantly. Phase 11 at the latest.
- **No build script.** `tsx` runs TypeScript directly, which is fine for
  development, but a compiled build must copy `src/db/migrations/*.sql` into
  `dist/`. Noted in `migrate.ts`; due in Phase 12.
- **`docker-compose.yml` has never been executed.** Committed and labelled
  as such. Should be verified on a machine with Docker before anyone relies on
  it.
- **Migrations run manually.** No automatic migrate-on-boot. Correct — automatic
  migration on boot means N instances racing (the advisory lock handles it, but
  a failed migration then takes down the whole deployment).
- **No rate limiting** on health endpoints. Fine locally; needed before any
  public exposure.
