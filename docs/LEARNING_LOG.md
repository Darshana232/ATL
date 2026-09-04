# Learning Log

What was learned while building, phase by phase — including the mistakes,
because those are the parts worth re-reading.

---

## Phase 1 — Foundation (2026-09-04)

### Concepts covered

**Git**
- `git init -b main`; why `main` is specified rather than inherited.
- `.gitignore` before the first commit. A secret committed once lives in
  history forever — the remedy is key rotation, not `git rm`.
- `git check-ignore -v .env` to *prove* a file is ignored instead of assuming.
- Atomic commits: one logical change per commit, with a message explaining
  **why** rather than restating the diff.

**TypeScript**
- `strict`, plus three flags it does *not* include:
  `noUncheckedIndexedAccess` (makes `arr[0]` be `T | undefined`),
  `noFallthroughCasesInSwitch`, `noImplicitOverride`.
- ESM with `.js` extensions in import paths even though the files are `.ts` —
  ESM resolves real paths at runtime; TypeScript maps `.js` → `.ts` at compile
  time.
- **Deriving types from values**: `ReturnType<typeof pino>` instead of guessing
  at a library's exported type names. Also used for `ReturnType<typeof
  buildServer>`.
- Type-checking tests too, by including `*.test.ts` in `tsconfig`. A test that
  does not compile is a test that silently is not testing.

**Validation and configuration**
- One module owns `process.env`; everything else receives a typed object.
- Fail-fast at boot beats a runtime mystery on request #4,000.
- `z.coerce` because every environment variable is a string.
- **Empty string ≠ missing.** `KEY=` in `.env` yields `''`, not `undefined`, so
  `.optional()` accepts it and the failure surfaces much later as an opaque 401.
- Reporting *all* validation problems at once, so one restart fixes a batch.
- `Object.freeze` so config cannot be mutated at runtime.
- Environment-conditional rules: production must have the signing secret.

**Databases and SQL**
- Connection pooling: a TCP handshake plus authentication costs ~5–15 ms;
  a pool pays it once.
- **Pool size is a cluster-wide budget**, not a per-process preference.
  `instances × max ≤ max_connections − headroom`. Getting this wrong is one of
  the most common ways teams take down their own database.
- `connectionTimeoutMillis` as backpressure: a clear 503 beats an unbounded
  hang that leaks sockets and memory.
- An unhandled `'error'` event on an idle client **crashes the Node process**;
  three lines of handler prevent an outage when Postgres restarts.
- `TIMESTAMPTZ` vs `TIMESTAMP` — the latter is ambiguous and unacceptable in an
  audit record.
- `CHECK` constraints as defence in depth: proven by inserting bad rows in raw
  SQL, bypassing all application code. Six of six invalid rows rejected.
- Index what you **filter** on. Partial indexes (`WHERE status = 'active'`) are
  smaller, faster and cheaper to maintain.
- Transactional DDL: Postgres rolls back a failed migration entirely. MySQL and
  Oracle do not give you this.
- A transaction lives on **one connection** — `pool.query()` may hand out a
  different connection per call, so `BEGIN` on one and `COMMIT` on another does
  nothing useful.
- `pg_advisory_lock` to serialise concurrent migrators.

**Cryptography (first contact)**
- SHA-256 checksums to detect modification of applied migrations. Same idea as
  the Phase 6 audit hash chain, at smaller scale: append-only history plus
  hash-based tamper detection.

**APIs and HTTP**
- Liveness vs readiness, and why conflating them causes a thundering-herd
  outage.
- Status codes are a machine contract: a load balancer reads `503`, not your
  JSON body.
- Request IDs, and honouring a caller-supplied `x-request-id` so one trace
  survives across services.
- Error-handler policy: describe 4xx (the caller's problem), never describe 5xx
  (ours) — return an opaque message plus the request ID.
- `bodyLimit` as denial-of-service protection.

**Security**
- Information disclosure via health endpoints and error messages — the least
  protected route in most services.
- Central log redaction by field path, rather than trusting every future call
  site to remember. Doubles as a DPDP data-minimisation control.
- Never echo a received value in a validation error.
- Binding to `127.0.0.1` in development rather than `0.0.0.0`.
- `.env` at mode `600`.

**Testing**
- Unit vs integration: a config test needs no database; a `REVOKE` cannot be
  unit-tested.
- `app.inject()` — real router, hooks, handler and serialisation, with no port
  binding and therefore no flakiness.
- Dependency injection existing *for* testability: `buildServer({config,
  logger, pool})` accepts a deliberately broken pool.
- **Testing the failure path**, not just the happy path.
- **A test you have never seen fail is not a test.** We deliberately made the
  health endpoint leak its database error and watched the security test catch
  `ECONNREFUSED`, then reverted.
- `fileParallelism: false` when integration tests share one database.

**Operations**
- Graceful shutdown on `SIGTERM`/`SIGINT`, in the right order: stop accepting
  work, drain in-flight requests, *then* close the pool.
- A hard timeout guard so a hung shutdown still exits deliberately rather than
  being `SIGKILL`ed mid-write.
- Twelve-factor logging: write JSON to stdout, let the platform route it.
- Structured logs with a `service` and `env` on every line.

---

### Mistakes made, and what they teach

**1. Assumed pnpm would install cleanly.**
`corepack enable pnpm` failed with `EACCES` because `/usr/local/bin` is
root-owned. *Lesson:* verify the toolchain before designing around it. We
switched to npm workspaces (ADR-0003) rather than requiring `sudo` as a side
effect of project setup.

**2. Assumed Docker was available.**
It was not. *Lesson:* the plan said "Docker Compose Postgres" without checking.
Checking took 20 seconds and changed a decision. Environment assumptions are
assumptions.

**3. Used `$PIPESTATUS` in a zsh shell.**
It is a bash array; zsh spells it `$pipestatus`. The command silently reported
nothing, which briefly looked like "tsc produced no output, so it passed" —
when in fact *nothing had been measured*. *Lesson:* an empty result is not a
pass. Check exit codes explicitly.

**4. Fought TypeScript over Fastify's logger generic.**
Passing a concrete `pino.Logger` as `loggerInstance` specialised the entire
`FastifyInstance` type, so it no longer matched `FastifyInstance` with default
generics — and the broken inference cascaded, degrading the error handler's
`error` parameter to `unknown`. The fix was to *upcast* to Fastify's own
`FastifyBaseLogger` (pino's type is strictly richer, so widening is safe).
*Lesson:* read the **last** line of a long TypeScript error — it names the
actual incompatibility. And when a library is generic over something you pass
in, expect the specialisation to propagate.

**5. Quoted a whole command into a shell variable.**
`PSQL="psql -d db -X"` then `$PSQL -c '...'` fails in zsh, which does not
word-split unquoted variables the way bash does. *Lesson:* put directories on
`PATH`; do not stuff commands with arguments into variables.

---

### How a senior engineer would have approached Phase 1

- Run the environment audit **first** (`node`, `npm`, `docker`, `psql`, `brew`)
  before writing a plan that depends on any of them.
- Write the security tests at the same time as the endpoint, not after — they
  are requirements, not verification.
- Prove the claimed properties by breaking them (tamper detection, constraint
  enforcement, information disclosure) rather than asserting them in a comment.
  A comment is a wish; a test is a guarantee.
- Record decisions while the reasoning is fresh. Reconstructed rationale is
  always worse and usually wrong.

---

### What to study next (smallest useful path)

1. **Postgres indexing** — Markus Winand, *Use The Index, Luke!*
   (use-the-index-luke.com). Free, short, immediately applicable to Phase 2.
2. **`EXPLAIN ANALYZE`** — run it on one query in Phase 2 and read the plan.
3. **Transaction isolation levels** — the Postgres docs chapter on concurrency
   control. Directly needed for velocity counting in Phase 4.
4. **The Twelve-Factor App** (12factor.net), sections on config and logs. Two
   pages; explains *why* Phase 1 looks the way it does.
5. **Zod docs**, the `preprocess`/`refine`/`transform` section — the mental
   model transfers to every validation boundary we add.

Do not go broader than this list yet. Phase 2 will supply the next one.
