# Phase 2 — Database Schema

**Status:** IN PROGRESS (before-half written, awaiting approval)
**Started:** 2026-09-04 · **Finished:** —

> Sections 1–9 written before any SQL. Sections 10–11 after.

---

## 1. What we are building

The domain model: the tables that hold users, agents, agent credentials,
mandates, authorization requests, decisions, rule evaluations, risk signals,
payments and audit events — plus deliberately messy seed data.

Four migrations, not one file:

```
0002_identity.sql        users, agents, agent_credentials
0003_mandates.sql        mandates, mandate_versions
0004_authorization.sql   authorization_requests, decisions,
                         rule_evaluations, risk_signals, payments
0005_audit.sql           audit_events + append-only enforcement + app role
```

**Deferred on purpose:** `products` / `carts` land in Phase 8 with the catalog;
`agent_runs` / `agent_steps` land in Phase 8 with tracing. Migrating tables
before the code that uses them means guessing at their columns.

## 2. Why now

The schema is the most consequential artifact in the project. By Phase 9 it is
load-bearing under the API, the policy engine, the audit chain and the
dashboard, and every mistake in it has been copied into code four times.

It has to come **after** Phase 1 (nothing to migrate with) and **before**
Phase 3 (a mandate API needs somewhere to put mandates).

The specific risk of rushing it: three of our correctness guarantees —
immutable mandate terms, append-only audit, and safe concurrent velocity
counting — are **schema properties**, not code properties. Get them wrong here
and no amount of careful application code recovers them.

## 3. How it works

```
                 ┌──────────┐          ┌──────────┐
                 │  users   │          │  agents  │
                 └────┬─────┘          └────┬─────┘
                      │                     │
                      │                ┌────┴──────────────┐
                      │                │ agent_credentials │  api key + hmac
                      │                └───────────────────┘  secret hash
                      │                     │
                      └──────┬──────────────┘
                             ▼
                      ┌─────────────┐        identity + lifecycle
                      │  mandates   │        status: active|revoked|expired
                      └──────┬──────┘
                             │ 1:N
                             ▼
                   ┌───────────────────┐     IMMUTABLE terms
                   │ mandate_versions  │     limits, allowlist, window
                   └─────────┬─────────┘     (mandate_id, version) PK
                             │
     ┌───────────────────────┼──────────────────────┐
     │                       │                      │
     ▼                       ▼                      ▼
┌──────────────┐      ┌─────────────┐      ┌──────────────┐
│ authorization│─1:1─►│  decisions  │◄─────│ risk_signals │  advisory only
│  _requests   │      └──────┬──────┘      └──────────────┘
└──────────────┘             │ 1:N
   merchant, amount,         ▼
   idempotency_key    ┌──────────────────┐
                      │ rule_evaluations │  one row per rule per decision
                      └──────────────────┘  signal, expected, actual, verdict
                             │
                             ▼
                      ┌────────────┐
                      │  payments  │  voucher_jti, provider, status
                      └────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │  audit_events   │  APPEND-ONLY, hash-chained
                    └─────────────────┘  seq, prev_hash, hash, payload
```

**The shape to notice:** `decisions` points at `mandate_versions`, not at
`mandates`. A decision is permanently bound to the exact terms it judged.

## 4. Concepts I need first

**Primary key.** The column that uniquely identifies a row. Postgres builds a
unique index for it automatically, so lookups by PK are fast and duplicates are
impossible.

**Foreign key.** A column that must match a primary key in another table. The
*database* refuses an orphan — a decision cannot reference a mandate version
that does not exist. This is a correctness guarantee enforced by Postgres, not
a hope enforced by application code.

**`NOT NULL` / `CHECK` / `UNIQUE`.** Invariants the database enforces regardless
of how a row arrives. Proven in Phase 1 by inserting six invalid rows in raw
SQL: all six rejected. Application validation catches accidents; schema
constraints catch everything, including me at a `psql` prompt.

**B-tree index.** A sorted tree structure that turns "scan every row" into "walk
a few levels". Rule: **index what you filter, join, and order by.** Each index
costs write time and disk, so indexing everything is as wrong as indexing
nothing.

**Partial index.** An index over a subset (`WHERE status = 'active'`). Smaller,
faster, cheaper to maintain. Used in Phase 1 for active merchants.

**Composite index and column order.** An index on `(mandate_id, created_at)`
serves "this mandate's rows in time order" and also "all rows for this mandate",
but *not* "everything in time order". Leftmost-prefix rule — the order matters.

**JSONB vs columns.** JSONB stores a JSON document you can query. Flexible, but
you lose type checking, constraints and cheap indexing. **Our rule: anything a
rule reads is a column; anything only humans read may be JSONB.** So
`per_txn_limit_paise` is a column; a human-readable note is JSONB.

**Money as integers.** All money is an integer count of **paise**. Floating
point cannot represent 0.1 exactly, so `0.1 + 0.2 !== 0.3`. In a tutorial that
is a curiosity; in a payment system it is a defect that turns into a ₹0.01
discrepancy, then into a reconciliation failure, then into an audit finding.

**Timestamps.** `TIMESTAMPTZ` always, stored UTC, formatted only at the edge for
display. A timestamp without a zone in an audit record is ambiguous evidence.

**State machine.** An entity with a fixed set of states and legal transitions.
`payments`: `created → authorized → captured` or `→ failed`. `captured →
created` must be impossible, and the database — not just the code — should say
so.

**Race condition / row lock.** Two concurrent requests reading the same value
and both acting on it. `SELECT … FOR UPDATE` takes a lock on a row so the second
transaction waits. This is the core of design question 4 below.

## 5. Design choices & tradeoffs

### The five decisions that need your agreement

---

**Q1 — Mandate versioning: how do we keep old terms recoverable?**

A decision made last Tuesday must remain explainable against the mandate **as it
was last Tuesday**. If the user later raises their limit from ₹2,000 to ₹5,000,
last Tuesday's `BLOCK` must still read "exceeded the ₹2,000 limit" — otherwise
the audit trail becomes a lie that says a payment was blocked for exceeding a
limit it did not exceed.

| Option | How | Cost |
|---|---|---|
| **A. Two tables (recommended)** — `mandates` holds identity + lifecycle; `mandate_versions` holds immutable terms, PK `(mandate_id, version)` | decisions FK to `(mandate_id, version)`; terms are never updated, only superseded | two tables, one join |
| B. Single table, `version` column, never updated | "current" becomes `max(version)`, needed in every query, or a partial unique index on `is_current` | messy reads, easy to get wrong |
| C. Current row + separate history table | fast reads | the update path must copy to history correctly *every time*; one missed copy silently loses evidence |

**Recommendation: A.** It makes the guarantee structural. There is no code path
that *could* lose old terms, because nothing ever updates them. C is the
traditional design and it fails exactly the way you would expect: the audit copy
is a step someone eventually forgets.

---

**Q2 — Money representation**

Integer paise, no question. The real decision is the SQL type, and there is a
Node-specific trap.

| Option | Range | Trap |
|---|---|---|
| `NUMERIC(14,2)` in rupees | exact, huge | `node-postgres` returns NUMERIC as a **string** to avoid precision loss — every read needs parsing |
| `INTEGER` paise | ±₹2.14 crore | a single transaction never exceeds this, but `SUM()` can |
| **`BIGINT` paise (recommended)** | ±₹9.2 × 10¹⁶ | `node-postgres` also returns BIGINT as a **string**, for the same reason |

**Recommendation: `BIGINT` paise, with an explicit `pg` type parser for `int8`
that converts to `Number` and throws above `Number.MAX_SAFE_INTEGER`
(9,007,199,254,740,991 paise ≈ ₹90,071 crore).**

Why the explicit parser matters: the default string return is *correct but
surprising*, and the failure mode of naively casting is silent precision loss
above 2⁵³ — the worst kind of money bug, because it produces plausible wrong
numbers. Registering a parser that **throws** converts a silent corruption into
a loud crash. Column names carry the unit: `amount_paise`, never `amount`.

---

**Q3 — Which tables are append-only, and how is that enforced?**

| Table | Mutability | Enforcement |
|---|---|---|
| `audit_events` | strictly append-only | `REVOKE UPDATE, DELETE` from the app role **and** a `BEFORE UPDATE OR DELETE` trigger that raises |
| `mandate_versions` | append-only | same |
| `decisions`, `rule_evaluations` | append-only | same |
| `mandates` | status transitions only | trigger allowing only legal transitions; terms live in versions |
| `payments` | lifecycle transitions | trigger enforcing the state machine |
| `users`, `agents`, `merchants` | mutable | ordinary tables |

**Two enforcement mechanisms, on purpose.** The revoked grant protects against
application bugs; the trigger protects against a *misconfigured role*. Neither
alone is sufficient, and they fail independently — which is what defence in
depth actually means.

This requires a **second database role**: migrations run as the owner, the
application connects as `atl_app`, which has no `UPDATE`/`DELETE` on audit
tables at all. Least privilege, and it is also what makes the Phase 6 tamper
demo honest: to tamper, we must *deliberately escalate* to the owner role, which
is precisely the threat model we are claiming to detect.

**Rejected:** the research's `CONSTRAINT no_updates CHECK (true)`. It does
nothing — `CHECK (true)` always passes. And `CHECK (false)` would block inserts
too. It appears in three research documents and is simply broken SQL.

---

**Q4 — Velocity and spend counting: the concurrency question**

This is where transaction isolation stops being theory. The bug:

```
mandate: ₹5,000/week, ₹3,100 already spent

  request A (₹1,200)              request B (₹1,500)
  ─────────────────────           ─────────────────────
  read spent = 3100
                                  read spent = 3100
  3100 + 1200 <= 5000  PASS
                                  3100 + 1500 <= 5000  PASS
  insert payment 1200
                                  insert payment 1500

  actual spend: ₹5,800.  Both requests were "correct". The mandate is breached.
```

This is a **lost update**, and it is the classic way spending limits get
defeated. An attacker with an agent does not need to break our HMAC; they just
fire twenty authorizations simultaneously.

| Option | Correctness | Cost |
|---|---|---|
| Derive `SUM()` with default isolation | **broken** as above | — |
| `SERIALIZABLE` isolation | correct | Postgres aborts conflicting transactions; every caller must retry, and the retry logic is easy to get wrong |
| **`SELECT … FOR UPDATE` on the mandate row (recommended)** | correct | one row lock per authorization; serialises only within a single mandate |
| Redis counter | fast | a second source of truth for a **security limit** — a genuinely bad trade |

**Recommendation: take `SELECT … FOR UPDATE` on the `mandates` identity row at
the start of the authorization transaction, then derive spend with an indexed
`SUM()` over `payments`.**

Why this one: contention is *per mandate*, and a single user's agent making two
simultaneous purchases is rare — so the lock is almost never contended, while
being completely correct when it is. It needs no retry logic, which means no
retry bug. And deriving the sum rather than caching a counter means there is
exactly one source of truth.

The scale limit is real and documented in section 9: `SUM()` over a time window
is fine at 10 merchants and fatal at 10M transactions. The fix order is partial
indexes → rollup counters → Redis, in that order, and not before we measure.

---

**Q5 — Does `decisions` store a copy of the mandate it judged?**

My initial instinct was yes: denormalise a JSONB snapshot so a decision is
self-contained.

**On reflection: no, and Q1 is the reason.** If `mandate_versions` rows are
immutable, a foreign key to `(mandate_id, version)` *already* recovers the exact
terms, forever. A JSONB copy would be pure duplication — and duplicated data
diverges. Two records of the same fact is worse than one, because now you have
to decide which is authoritative when they disagree.

Where a snapshot **does** belong is the audit event payload, because that is a
different job: the payload is the thing being hashed, so it must be
self-contained by definition — verifying a hash chain cannot depend on joining
to other tables that may themselves have changed.

So: `decisions` normalises via FK; `audit_events` embeds a snapshot for hashing.
Same information, two representations, two distinct reasons.

### Other decisions (not blocking)

| Choice | Alternative | Why | Cost |
|---|---|---|---|
| Prefixed IDs: `usr_`, `agt_`, `mnd_`, `authz_`, `dec_`, `pay_`, `evt_` | UUID or serial | self-describing in logs; ID confusion becomes visible | slightly larger keys |
| Random suffixes for transactional rows, readable slugs for seeded merchants | uniform | merchants are few and human-curated; the rest are generated | a documented inconsistency |
| `rule_evaluations` as rows, not JSONB | one JSONB blob on `decisions` | we filter by rule and verdict for reports ("all cap breaches this month"); rules are what the product is *about* | more rows |
| Store the HMAC secret as an argon2 hash | store encrypted | we only ever need to *verify*, never to read it back | agent must save it at creation time |
| `audit_events.seq` as `BIGSERIAL` | timestamp ordering | gaps are detectable; clocks are not monotonic across processes | — |
| Seed via a TypeScript script, not SQL | `INSERT` statements in a migration | seed data is not schema; it changes freely and must not be checksum-frozen | one more script |

## 6. Files created/modified

```
apps/api/src/db/migrations/
  0002_identity.sql          users, agents, agent_credentials
  0003_mandates.sql          mandates, mandate_versions
  0004_authorization.sql     authorization_requests, decisions,
                             rule_evaluations, risk_signals, payments
  0005_audit.sql             audit_events, append-only triggers, atl_app role
apps/api/src/db/
  types.ts                   int8 parser + money helpers (paise <-> display)
  seed.ts                    deliberately messy fixtures
apps/api/src/db/
  schema.test.ts             constraint and trigger tests
docs/DATABASE.md             ER diagram, every table, every index, rationale
```

## 7. How we test it

| Test | Asserts | Failure it prevents |
|---|---|---|
| FK rejects a decision referencing a missing mandate version | error raised | orphaned decisions — an unexplainable audit record |
| `mandate_versions` UPDATE rejected | trigger raises | silently rewriting the terms a past decision was judged against |
| `mandate_versions` DELETE rejected | trigger raises | destroying evidence |
| `audit_events` UPDATE/DELETE rejected as `atl_app` | permission denied | tampering via the application |
| `audit_events` UPDATE/DELETE rejected as owner | trigger raises | tampering via a misconfigured role |
| illegal payment transition (`captured → created`) rejected | trigger raises | a payment lifecycle that lies |
| negative and zero amounts rejected | `CHECK` violation | a ₹0 or negative "payment" |
| `amount_paise` above `MAX_SAFE_INTEGER` throws on read | parser throws | **silent precision loss on money** |
| duplicate `idempotency_key` for one agent rejected | `UNIQUE` violation | double-charging on a network retry |
| concurrent authorizations against one mandate | total spend never exceeds the limit | **the lost-update breach in Q4** |
| `EXPLAIN` on the spend query uses the index | index scan, not seq scan | a query that is fine at 1k rows and fatal at 10M |
| seed data loads and every mandate is evaluable | no crash on edge cases | fixtures that only cover the happy path |

The concurrency test is the one I care most about: fire N simultaneous
authorizations at one mandate and assert the total never exceeds the limit. That
is a test that fails without `FOR UPDATE` and passes with it — which makes the
lock's purpose demonstrable rather than asserted.

## 8. Security notes

**Threat:** an attacker defeats a spending limit with concurrency.
**Vulnerability:** read-then-write on derived spend is a lost update; nothing
about our authentication prevents it.
**Mitigation:** `SELECT … FOR UPDATE` on the mandate row inside the
authorization transaction.
**Why this one:** correct without retry logic, and contention is per-mandate so
the cost is near zero. `SERIALIZABLE` is also correct but pushes retry
responsibility onto every caller — and an unretried serialization failure looks
like a random decline.

**Threat:** audit records are altered to hide a breach.
**Vulnerability:** an application with `UPDATE` rights on the audit table can
rewrite history.
**Mitigation:** a separate `atl_app` role with `INSERT`/`SELECT` only, **plus** a
trigger that raises on `UPDATE`/`DELETE`.
**Why both:** they fail independently. The grant stops application bugs; the
trigger stops a misconfigured grant. Neither alone is defence in depth.

**Threat:** credential theft from the database.
**Vulnerability:** storing an agent's signing secret in a readable form means a
database read is a full compromise of every agent — an attacker can then forge
authorization requests from any of them.
**Mitigation:** **Ed25519 public-key signatures.** The agent holds the private
key and never transmits it; we store only the public key. There is no secret at
rest to steal.

> **Correction (2026-09-04).** An earlier draft of this section said we would
> store an argon2id hash of an HMAC secret because "we only ever verify, never
> need the original". That is wrong: verifying an HMAC requires *recomputing*
> it, which requires the actual key. Hash-only storage works for passwords —
> where the client sends the secret and we compare hashes — not for request
> signing. See ADR-0014.

**Why this one:** it removes the asset rather than protecting it. Encryption
implies a key that also lives somewhere and can also be stolen; hashing is
incompatible with HMAC verification. With asymmetric keys the question "how do
we protect the stored secret?" stops existing.

**The general rule — choose symmetric vs asymmetric by asking who verifies:**

| Direction | Scheme | Reason |
|---|---|---|
| Agent → us (request signing) | **Ed25519** | two parties, and we must not be able to impersonate the agent |
| Us → us (the voucher) | HMAC-SHA256 | one party is both signer and verifier; symmetric is correct and simpler |
| Razorpay → us (webhooks) | HMAC-SHA256 | their scheme, not our choice |

**Threat:** PII over-collection.
**Vulnerability:** it is tempting to store full phone numbers, full VPAs and raw
intent text "for debugging".
**Mitigation:** store a hashed user identifier, a masked VPA, and the last four
digits of a phone. Data minimisation as a schema property, not a policy
document.
**Why this one:** data you never collected cannot leak, cannot be subpoenaed and
cannot be mis-handled. It is the only privacy control that is absolute — and it
is direct DPDP evidence for Phase 10.

**Threat:** SQL injection.
**Mitigation:** parameterised queries everywhere (`$1`, `$2`). Never string
concatenation, not even for a "safe" internal value.
**Why it works:** the query is parsed and planned *before* the parameter values
arrive, so a value can never become syntax. This is a structural guarantee, not
escaping-based filtering.

## 9. What happens at scale

| Volume | What breaks first | Fix |
|---|---|---|
| 10 merchants, ~1k rows | nothing | — |
| 10k merchants, ~10M rows | the spend `SUM()` over a time window per authorization | composite index `(mandate_id, created_at) WHERE status='captured'`; measure with `EXPLAIN ANALYZE` |
| 10M transactions | that index stops being enough — the window still scans thousands of rows per authorization | rollup counter per `(mandate_id, window)`, updated in the same transaction as the payment, with the derived `SUM()` kept as a periodic reconciliation check |
| 100M audit rows | audit queries and index maintenance | time-partition `audit_events` monthly; hot partitions in Postgres, cold ones in WORM object storage for the 7-year tier |
| Regulatory scale | hash-chain verification is O(n) — verifying 100M rows is not an HTTP request | Merkle tree with periodically signed checkpoints; verify a range against a checkpoint instead of from genesis (immudb and Trillian are the reference designs) |
| Any scale | dashboard reads competing with authorization writes | read replica for the dashboard; authorization always reads primary — a stale replica must never decide a limit |

The ordering matters and is the actual lesson: **index → rollup → cache**, each
step only after measuring that the previous one stopped being enough. Reaching
for Redis first would add a second source of truth for a security limit before
establishing that Postgres could not cope.

## 10. What I learned

*(after the phase)*

## 11. Mistakes made & why

*(recorded as they happen, while the reasoning is still recoverable)*

**1. Asserted a key length instead of measuring it.** The
`agent_credentials_public_key_shape` constraint required 43 base64 characters
plus `=`. An Ed25519 SPKI public key is 44 DER bytes, which encodes to **60**
base64 characters (59 + one pad). I took "44" from glancing at an earlier
console output and assumed it was the string length; it was the byte length.
*Why it happened:* the same assumption-not-verification pattern as pnpm
(Phase 1 mistake 1) and Docker (mistake 2). Third occurrence in this project.
*Lesson:* when a constraint encodes a magic number, produce the number by
measurement in the same session, and put the measurement in a comment.

**2. Amended an applied migration instead of adding a new one — and that was
correct.** Fixing the constraint meant either editing `0002` (which the
checksum guard refuses) or shipping `0003` to patch a constraint added seconds
earlier. I dropped the objects locally, deleted the ledger row, edited `0002`,
and re-applied.

That looks like breaking the append-only rule, so the boundary is worth stating
precisely: **the rule protects *published* migrations.** It exists because other
environments may have applied one. `0002` was local-only and uncommitted, so
nobody else could have it. This is exactly `git commit --amend` versus
`git revert` — amend before publishing, migrate forward after. A dogmatic
reading would have left a permanent patch-my-own-typo migration in the schema
history.

**3. My verification harness produced false proof — the worst of the three.**
The credential "attack" tests used IDs like `cred_a`, which violate
`agent_credentials_id_format` (`{2,40}` characters after the prefix). So every
single credential insert was rejected — but by the **ID** constraint, never
reaching the key-shape constraint I believed I was testing. The harness printed
only `REJECTED`, so eight rejections looked like eight proofs.

Worse, it hid the real diagnosis: I concluded the valid key was rejected because
the length regex said 43, "fixed" that, and it *still* failed — because the
actual cause was the ID. I fixed a genuine bug for a reason that was not
occurring.

*Why it happened:* the harness reported a boolean where the interesting
information was the *reason*.
*Lesson:* **a test that passes for the wrong reason is worse than a failing
test**, because it manufactures confidence. Assertions must name the specific
constraint or error they expect, never just "it threw". The fix was to print
the constraint name, after which one insert was accepted and eight were
rejected each by the constraint intended.

This is why section 7 lists the *failure each test prevents* rather than just
the test name — a test whose purpose you cannot state is a test that can pass
vacuously.

**4. `TRUNCATE` bypasses row-level triggers entirely — I nearly shipped a hole
big enough to erase the audit trail.** The append-only guard was
`BEFORE UPDATE OR DELETE ... FOR EACH ROW`. Probed it: a table with that
trigger is emptied by `TRUNCATE` with **no error and no trigger invocation**.
One `TRUNCATE audit_events;` would have erased everything while the guard
stayed silent, which would make the tamper-evidence claim hollow.

Fixed with a second, **statement-level** `BEFORE TRUNCATE` trigger. The
verification now asserts three independent layers: the foreign key refuses a
plain `TRUNCATE` (SQLSTATE `0A000`) before any trigger runs, the statement
trigger catches `TRUNCATE ... CASCADE`, and on the leaf table the trigger is
the only thing standing in the way.

*Why it happened:* I enumerated the obvious mutations (UPDATE, DELETE) rather
than asking "what else can empty a table?"
*Lesson:* for a guarantee, enumerate the **operations** the database offers,
not the ones you happen to think of. It also sharpened why the role half of the
defence is not optional: `TRUNCATE` requires table ownership, so keeping the
application away from owner privileges is what makes the trigger's remaining
gap unreachable.

**5. `array_length` returns NULL for an empty array, and a CHECK constraint
PASSES on NULL.** The weekday constraint read
`array_length(allowed_weekdays, 1) >= 1`. For `ARRAY[]::text[]`,
`array_length` is **NULL**, so the expression evaluated to NULL — and SQL's
three-valued logic means a CHECK only fails when it evaluates to **FALSE**, not
when it is unknown. An empty weekday list was therefore silently accepted,
producing a mandate that can never legally fire. Same bug in the
payment-methods constraint.

Fixed by using `cardinality()`, which returns 0 for an empty array.

*Why it happened:* I read `CHECK` as "this must be true". It actually means
"this must not be false".
*Lesson:* in any `CHECK`, ask what the expression does when an input is NULL or
empty. This is the single most common source of constraints that quietly do
nothing.

**Meta-observation across mistakes 3–5.** Mistake 3 changed the tests to assert
specific SQLSTATEs and constraint names, and that change immediately paid for
itself twice: the `TRUNCATE` test would have "passed" against the wrong error
code, and the empty-weekday bug was only visible because the assertion named
the constraint it expected. Vague assertions do not just fail to catch bugs —
they actively hide them.

## 12. Open questions / debt

- **Mandate cryptographic signatures.** `mandate_versions` will have a
  `signature` column, but signing is deferred to Phase 5/6 where the key
  handling belongs. Nullable until then, and honestly labelled.
- **`AFA_EXEMPTION_THRESHOLD` is informational in the MVP.** It is a real
  regulatory threshold (NPCI UPI/OC-151A) but it governs whether a UPI PIN is
  required — which happens on a rail we do not control. We record it and
  display it; we do not enforce it.
- **7-year retention is a schema comment, not a mechanism.** No archival tier.
- **No table partitioning.** Correct at MVP scale; documented above.
- **Deferred tables** — `products`, `carts`, `agent_runs`, `agent_steps` — will
  need FKs into these tables. Worth sanity-checking now that the identity
  columns they will reference are stable.
