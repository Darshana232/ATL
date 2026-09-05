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

---

## Phase 5 — The authorization API

**Concepts**

1. **Signing is not encrypting.** A signature hides nothing; it proves the bytes
   were not altered and that the sender holds the private key. Confidentiality
   is TLS's job.
2. **Choose asymmetric vs symmetric by asking who needs to verify.** Two parties
   where one must not impersonate the other → asymmetric (Ed25519, agent → us).
   One party minting *and* verifying → symmetric (HMAC, our voucher).
3. **Why an HMAC secret cannot be stored as a hash.** Verifying an HMAC requires
   recomputing it, which requires the real key. Hash-only storage is right for
   passwords, wrong for request signing.
4. **Canonical signing strings and field-splitting ambiguity.** Without
   separators, `"ab"+"cd"` and `"a"+"bcd"` are the same bytes — one signature
   would authorise two different requests.
5. **Replay ≠ idempotency, but one mechanism solves both** when the idempotency
   key is inside the signature and unique in the database.
6. **Capability tokens vs identity tokens.** "the bearer may capture ₹1,240 at
   this merchant, once, before 08:53" is a far smaller thing to leak than
   "I am agent X".
7. **TOCTOU.** Two correct evaluations can still produce a wrong outcome if they
   are allowed to overlap. The fix is a lock, not a smarter check.
8. **`SELECT … FOR UPDATE`** vs SERIALIZABLE vs advisory locks — and why a retry
   loop is a cost, not a free upgrade.
9. **Timezone-aware calendar arithmetic** with `Intl`, including why a two-pass
   offset calculation is needed across a DST boundary, and why `getDay()`'s
   Sunday-is-0 would put Sunday's spending in the wrong week.
10. **Constant-time comparison**, and why `timingSafeEqual` throws on a length
    mismatch (so lengths are compared first).
11. **Fail closed.** No signing secret → mint no voucher. An unsigned "voucher"
    would be worse than none.
12. **Structural safety beats signalling.** A BLOCK returns 200 *and no token*.

**Skills practised**

- Writing security tests that name the attack they prevent, not the function
  they call.
- Running **positive controls**: deliberately breaking the rule and the lock to
  confirm the suite noticed. Both did.
- Recognising a test that passes while executing nothing — twice now, in two
  different disguises.
- Multi-row parameterised INSERTs without string-interpolating values into SQL.
- Dependency-injecting a clock so time-dependent behaviour is testable and a
  demo is reproducible.

**Mistakes and what they taught**

- An HTTP test for duplicate headers passed without ever running the branch,
  because `inject` collapses them. → *Ask what would have to break for this test
  to fail. If nothing, it is not a test.*
- Clever index arithmetic in SQL-building code. → *In SQL builders, "clever" is
  a smell.*
- `mkdir` in a stale working directory. → *A shell remembers its cwd.*
- The demo blocked on TIME_WINDOW at 04:55. → *Pin what must be pinned, and say
  so on screen.*

**What to study next**

- RFC 8032 (Ed25519) — skim the security-considerations section only.
- AWS SigV4 and Stripe's webhook signature docs, as two real canonical-string
  designs to compare against ours.
- PostgreSQL docs, "Explicit Locking" and "Transaction Isolation".
- OWASP ASVS v4, section 2 (authentication) and section 3 (session management).

---

## Phase 6 — The tamper-evident audit trail

**Concepts**

1. **A hash chain proves consistency, not authenticity.** You cannot change one
   row — but someone who rewrites every row and every hash produces a chain that
   verifies perfectly. There is nothing outside the chain to compare it to.
2. **What a signed checkpoint actually buys**: it moves the requirement from
   "database write access" to "database write access AND secret exfiltration".
   It is not tamper-proofing.
3. **External anchoring** is the real answer, and why an MVP cannot do it: it
   needs a counterparty.
4. **Hashing the whole record, not just the payload.** Otherwise attribution —
   the part a regulator cares about most — is unprotected.
5. **Canonical serialisation**: sorted keys, and rejecting ambiguous values
   rather than coercing them.
6. **Streaming with keyset pagination**, and why `OFFSET` is both accidentally
   O(n²) and unstable on an append-only table.
7. **Constant-time comparison** for signatures, and comparing lengths first
   because `timingSafeEqual` throws on a mismatch.
8. **Key separation by purpose**, plus a config rule that refuses to boot when
   two keys are the same value.
9. **Fail closed**: no secret → no checkpoint, and `unreachable` rather than
   `valid`.
10. **Verify before you anchor** — signing over a broken chain launders the
    tampering.
11. **Triggers fire for the table owner.** Ownership alone is not enough to edit
    an append-only row; the attacker must disable the trigger, which is logged
    DDL.

**Skills practised**

- Writing a verifier that imports the writer's hash function rather than
  reimplementing it, so the two can never disagree.
- Simulating a privileged-insider attack honestly, including the steps that
  *fail* first.
- Designing a status enum where "unknown" is unreachable from "bad".

**Mistakes and what they taught**

- `unreachable` did not count as broken, so deleting the entire trail reported
  `intact`. → *A status meaning "unknown" must never be reachable from a
  condition meaning "bad".* Found by a test written to demo a feature.
- The duplicate-checkpoint test took three attempts: the first could not fail,
  the second depended on winning a race. → *Construct the condition; do not hope
  for it.* Third phase running with a version of this lesson.
- An early response said `verified` instead of `intact`. → *Do not let a green
  banner be screenshotted without its caveat.*

**What to study next**

- Certificate Transparency (RFC 6962) — the production version of everything in
  this phase, including Merkle trees and external anchoring.
- PostgreSQL docs: triggers, `ALTER TABLE … DISABLE TRIGGER`, and what the
  `session_replication_role` setting can bypass.
- "Keyset pagination" (Markus Winand, use-the-index-luke.com).

---

## Phase 7 — Payments and the agent runtime

**Concepts**

1. **Authorize vs capture**, and why a rail that separates them forces the
   webhook design rather than merely permitting it.
2. **Webhooks are at-least-once.** Retries on any non-2xx *and* on timeouts,
   including timeouts after success. Idempotency is not optional.
3. **Signing over raw bytes**, again — this time for an inbound request.
4. **Fail closed on a payment path.** "We do not know" must never be recorded as
   "money moved".
5. **Capability tokens beat bearer tokens** when you re-match the claims to the
   attempt.
6. **Prompt injection is designed around, not defended against.** Bound the
   authority, not the obedience.
7. **Tool-level authorization is two-sided**, and only one side is a control.
8. **One registry, two transports.** Adding MCP must add a transport, not a
   second policy.
9. **Granting a tool and granting authority are different questions.**
   `execute_payment` is safe to grant because the voucher is what makes it safe.
10. **A reference table with a foreign key** catches a typo in a capability name
    at insert time instead of silently granting nothing.

**Skills practised**

- Running controls that *break* the architecture and confirming the tests
  notice — including one that revealed a test passing for the wrong reason.
- Removing security layers one at a time to find out how many there actually
  are. There were four where I would have said one.
- Writing a deliberately gullible mock model, because a well-behaved one would
  have tested the wrong thing.
- Reading a fixture out of the seeded database instead of inventing it in the
  test file.

**Mistakes and what they taught**

- The forged voucher was 19 characters and died at a schema length check, so
  the MAC was never exercised. → *Green is not evidence; green plus a failing
  control is evidence.* Fourth phase with a version of this lesson.
- I invented tool names instead of reading the `tools` table. → *The foreign key
  is the authority.*
- The JSON parser ran before authentication. → *Authenticate first, interpret
  second — and check that the framework agrees with you.*
- A signed GET was impossible because the guard required a body. → *A signature
  scheme with two shapes has an ambiguity.*

**What to study next**

- Razorpay's Orders/Payments API docs and their webhook payload reference — as
  a worked example of a real authorize/capture split.
- Simon Willison's writing on prompt injection, particularly why detection is
  not a solution.
- The MCP specification, `tools/list` and `tools/call`.
- OWASP "Top 10 for LLM Applications", LLM01 (prompt injection) and LLM08
  (excessive agency) — the second is the one this phase is really about.

---

## Phase 8 — Dashboard and reports

**Concepts**

1. **A framework is not a certification.** FREE-AI is a committee report with no
   certifying authority — so a compliance percentage is not merely wrong, it is
   unmeasurable.
2. **A ratio and a percentage are different rhetorical objects.** "20/26"
   invites "which six?"; "77%" invites nothing.
3. **Composition of honest parts is not automatically honest.** Every control
   was truthful; the selection was not.
4. **Self-verifying reports**: a control that carries its own query cannot drift
   from the code.
5. **A failing query is not an empty one**, and neither is a pass.
6. **Data minimisation is architectural.** The strongest privacy control here is
   that the schema has nowhere to put a full phone number.
7. **Information hierarchy**: a compliance console exists to make the exception
   findable, so gaps render above successes and colour carries meaning only.
8. **Empty states are a correctness problem** — "nothing happened" and "the API
   is down" demand opposite responses.
9. **Server Components keep secrets on the server**, and a missing
   `NEXT_PUBLIC_` prefix turns that discipline into a build-time guarantee.
10. **Tabular numerals** — why digits must line up in a table of amounts.
11. **Indian digit grouping** (12,34,567) is not the same algorithm as
    thousands separators.

**Skills practised**

- Designing a measurement that can come out badly.
- Writing negative tests: scanning a response for `%` and "compliant" so the
  test fails when somebody "improves" the wording.
- Building a restrained design system where colour is semantic rather than
  decorative.
- Reading `EXPLAIN (ANALYZE, BUFFERS)` for plan shape rather than for timing.

**Mistakes and what they taught**

- The 20/20 coverage report. → *A number that cannot move is not a
  measurement.*
- A test that asserted an invariant instead of exercising a branch. → *If I
  cannot name what would have to break for this test to fail, it is not a test.*
  Fifth phase with this lesson.
- I invented `next@15.6.1` and two other versions that do not exist. → *`npm
  view` takes two seconds. Look it up; do not remember it.*

**What to study next**

- The RBI FREE-AI committee report itself — the seven sutras and six pillars, in
  the original.
- Next.js App Router: Server Components, `cache: 'no-store'`, Server Actions.
- Edward Tufte on data-ink ratio; Matthew Ström on colour in interfaces.
- `EXPLAIN` output: "Using EXPLAIN" in the PostgreSQL manual.
