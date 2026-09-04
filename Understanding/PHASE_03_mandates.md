# Phase 3 — Mandates

**Status:** IN PROGRESS (before-half written, decisions settled)
**Started:** 2026-09-04 · **Finished:** —

> Sections 1–9 before any code. Sections 10–12 after.

---

## 1. What we are building

The domain layer and HTTP API for mandates: create one, read it, read any past
version of it, add a new version, revoke it. Plus the first audit events, and
the first live call to an external API.

Phase 2 gave us a schema that already *enforces* the hard guarantees. Phase 3
is the code that uses it correctly and exposes it over HTTP.

## 2. Why now

The policy engine (Phase 4) needs something authoritative to evaluate against,
and it needs to be able to load *the exact version* a past decision used. Both
require this layer.

Doing it earlier was impossible — nowhere to store a mandate. Doing it later
would mean writing the engine against a repository that does not exist and
mocking the very thing whose correctness matters most.

It also has to come before the authorization API (Phase 5), because
"authorize" is meaningless without "the thing being authorized against".

## 3. How it works

```
POST /v1/mandates
  │  { userId, agentId, label, terms: { perTxnLimitPaise: 200000, ... },
  │    merchantIds: ["mer_bigbasket"], ifsc: "HDFC0000001" }
  ▼
┌──────────────────────────────────────────────────────────────────┐
│ 1  Zod parses the WIRE shape (DTO)                               │
│      integers, ISO strings, unknown fields rejected              │
│ 2  toDomain(dto) -> MandateDraft                                 │
│      Paise branded, dates as Date, invariants checked in code    │
│ 3  cold-path bank lookup (optional, 2s timeout, may fail)        │
│      BankLookupProvider: Razorpay IFSC | Static (tests)         │
│ 4  ONE transaction:                                              │
│      insert mandates                                             │
│      insert mandate_versions v1                                  │
│      insert mandate_version_merchants                            │
│      append audit event MANDATE_CREATED  (hash-chained)          │
│ 5  toWire(domain) -> response DTO                                │
└──────────────────────────────────────────────────────────────────┘
```

**Reading, on the hot path** — one round trip, not three:

```
loadForAuthorization(mandateId)
  └─ SELECT mandate, its CURRENT version (MAX(version)), and the allowlist
     aggregated into an array, in a single query.
     Used by Phase 4 on every authorization, so it must not be N+1.

loadVersion(mandateId, version)
  └─ a SPECIFIC historical version, for re-explaining a past decision.
     This is the read that the whole two-table design exists to make possible.
```

**Appending an audit event** (new in this phase):

```
append(event) inside the caller's transaction:
  1  pg_advisory_xact_lock(chain)      serialise appends to this chain
  2  read the current head             SELECT hash ORDER BY seq DESC LIMIT 1
  3  payload_hash = sha256(canonicalJson(payload))
  4  hash         = sha256(prev_hash || payload_hash)
  5  INSERT
```

Step 1 exists because appending is inherently serial: two concurrent appends
would read the same head, compute the same `prev_hash`, and the no-fork unique
index would reject one of them. A lock turns a hard failure into a short wait.

## 4. Concepts I need first

**DTO vs domain model.** The shape on the wire is not the shape in your logic.
The wire carries `{"perTxnLimitPaise": 200000}` — plain JSON, no types, from an
untrusted client. The domain carries branded `Paise` and real `Date` objects
with invariants already checked. Keeping them separate means an API change does
not ripple into business logic, and untrusted input cannot reach the domain
without passing validation.

**Branded (nominal) types.** TypeScript is *structurally* typed: any `number`
is assignable to any other `number`, so nothing stops
`chargeRupees(amountInPaise)`. A brand adds a phantom property that exists only
at compile time:

```ts
type Paise = number & { readonly __brand: 'Paise' };
```

Now `Paise` and a plain `number` are incompatible, and the only way to obtain
one is through a constructor that validates. Zero runtime cost.

**Value object.** A small immutable type defined by its value, with its
invariants enforced at construction. `MandateTerms` is one: once built, it is
known-coherent, so every function receiving it can skip re-checking.

**Repository.** The only module that knows SQL for an aggregate. Everything
above it receives domain objects. Swapping the query, adding an index or
changing the schema touches one file.

**Aggregate.** A cluster of objects treated as one unit for consistency — here
`Mandate` + its current `MandateVersion` + its allowlist. They are loaded and
written together, in one transaction, because a mandate with no version or a
version with no allowlist is not a valid state.

**Canonical JSON.** A byte-exact serialisation, so the same logical object
always produces the same hash. `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same
object but different bytes, so hashing raw `JSON.stringify` output would break
the chain the day a library reorders keys. Sort keys recursively, reject
non-finite numbers, and forbid `undefined`.

**Graceful degradation.** A non-critical dependency must not be able to fail a
critical operation. If the IFSC lookup times out, the mandate is still created;
the bank fields stay null and the degradation is recorded.

**Widening vs narrowing a permission.** Changing terms either *increases* what
the agent may do (raise a limit, add a merchant, unblock a category, extend
validity) or *decreases* it. The distinction matters for consent — see §5.

## 5. Design choices & tradeoffs

| Choice | Alternative | Why | Cost |
|---|---|---|---|
| Domain in `apps/api/src/domain/` | new `packages/core` workspace | nothing else consumes it yet — the dashboard is Phase 9, and the agent calls the API over HTTP rather than importing types. A package now costs build config and buys nothing (`CLAUDE.md` §6) | one move later if Phase 4 needs sharing |
| Wire uses **integer paise** (`perTxnLimitPaise: 200000`) | decimal strings (`"2000.00"`) | matches Razorpay's own API (`amount` in paise) and sidesteps JSON floats entirely — a JSON number is a double, so `2000.10` is already inexact | less human-readable; `paiseFromRupeeString` becomes a *dashboard input* helper, not an API concern |
| Brand `Paise` | plain `number` | rupees-vs-paise is the highest-value confusion to make impossible; costs one constructor | a little ceremony at boundaries |
| **IDs stay plain `string` aliases** (DECIDED) | brand every id type | our ids are prefixed (`mnd_`, `usr_`), so a mix-up is visible in logs, and the database already rejects a wrong-type id — `CHECK (id ~ '^mnd_…')` plus the foreign keys. The DB is the real backstop, so the compile-time layer would be belt-and-braces bought with friction in every file | a wrong-id bug surfaces at the database rather than at compile time |
| Repository returns domain objects, never rows | return `pg` rows | SQL stays in one file; callers cannot accidentally depend on column names | a mapping function per aggregate |
| `loadForAuthorization` is **one** query | three queries | it runs on every authorization; three round trips is an N+1 waiting to happen | a slightly gnarlier SQL with `array_agg` |
| Audit chain written now | defer to Phase 6 | not a choice: `hash` is `NOT NULL` and the no-fork index needs a correct `prev_hash`. Phase 6 becomes verification + checkpoints + tamper demo | canonical JSON has to be right first time |
| `pg_advisory_xact_lock` per chain | optimistic insert + retry on conflict | appending is inherently serial; a lock is a short wait instead of a retry loop, and retry loops are where concurrency bugs live | serialises appends — a documented scale limit (§9) |
| Bank lookup behind `BankLookupProvider` | call `fetch` inline | swappable for a static provider in tests, so the suite needs no network | one interface |
| Bank lookup **degrades gracefully** | fail the request | a compliance system must not be unable to create a mandate because a third party is down | bank fields may be null; recorded in the audit event |
| Minimal `X-ATL-Admin-Key` on these endpoints | ship them unauthenticated until Phase 5 | shipping unauthenticated mandate-mutation endpoints, even locally, is a bad state to normalise. ~20 lines closes it | a real auth model still arrives in Phase 5 |

### DECIDED — every version requires fresh consent

**Chosen: every new version, including version 1, must carry a consent
reference and a consent timestamp.** Enforced as `NOT NULL` columns, so the
database refuses a version without consent. There is no exception and no
classification step.

Note first what is *not* affected: the human-readable `label` lives on
`mandates`, not on `mandate_versions`, so renaming a mandate is not a version
change at all. Every version change alters the **terms** — what the agent is
permitted to do — and now every one of those needs consent.

**Why this over the alternative.** The obvious refinement is to gate only
*widening* changes (raise a limit, add a merchant, unblock a category) and let
*narrowing* ones through, since narrowing cannot harm the user. That is how
OAuth scope changes behave and it is a defensible model. It was rejected
because it requires a classifier — a function deciding whether a diff increases
authority — and **that function then becomes the thing standing between a user
and an unconsented limit increase.** A bug in it is a security bug, the
`mixed` case (one limit up, another down) needs a judgement call, and it would
need a Phase 10 report that recomputes classifications to audit itself.

`NOT NULL` needs none of that. There is no code path that can skip consent,
because there is no code involved. The cost is friction on purely protective
changes — a parent lowering a child's limit still re-confirms — and that is a
worthwhile price for a guarantee with no moving parts.

**What "consent" means in Phase 3, stated honestly.** There is no user-facing
consent UI until Phase 9, so `consent_ref` is an identifier supplied by the API
caller (an admin, in practice) pointing at wherever the consent was actually
obtained. Phase 3 therefore enforces that *a consent reference exists and is
recorded*, not that a human genuinely clicked something. That is a real
limitation and must be labelled as such in the Phase 10 DPDP register rather
than presented as end-to-end consent capture.

**A consequence worth knowing about.** `mandate_versions` is append-only, so
adding `NOT NULL` columns to it cannot be done the usual way — nullable, then
backfill with `UPDATE`, then `SET NOT NULL` — because our own trigger blocks
the backfill. See the migration note in §6.

### The rejected alternative, recorded so the reasoning survives

For reference, the narrowing/widening distinction we chose *not* to act on:

```
NARROWING (reduces the agent's authority)     WIDENING (increases it)
  lower a limit                                 raise a limit
  remove a merchant                             add a merchant
  block another MCC                             unblock an MCC
  shorten validity / narrow the time window     extend validity / widen the window
  reduce velocity                               raise velocity
```

Gating only the right-hand column would have needed a `classifyVersionChange()`
function, a `change_kind` column, a `CHECK` keyed off it, a judgement call for
`mixed` diffs, and a self-auditing report. `NOT NULL` replaces all of it.

Worth revisiting if consent friction ever becomes a real product problem — at
which point the classifier can be added *on top of* the always-consent
guarantee (as a UX shortcut that skips a prompt), rather than *instead of* it.
That ordering matters: a shortcut that fails leaves consent required, whereas a
gate that fails leaves consent skipped. Fail-closed by construction.

**Option C — no consent gate in the MVP.** Record `created_by` (already there)
and document the gap. Simplest, and defensible for a buildathon, but it means
the demo cannot claim consent is enforced.

**My recommendation: B.** It is the correct security model, it has a real-world
precedent a judge will recognise, the classifier is a deterministic pure
function that fits the Phase 4 style exactly, and "we re-verify consent only
when exposure increases" is a genuinely strong line in a pitch. The cost is one
small migration and one well-tested function.

## 6. Files created/modified

```
apps/api/src/domain/
  ids.ts            branded id types + validating constructors
  money.ts          (already exists) - Paise branding added
  mandate.ts        MandateTerms value object, Mandate, MandateVersion
  mandate.test.ts   invariants, boundary values
apps/api/src/dto/
  mandate.ts        Zod wire schemas + toDomain/toWire mappers
  mandate.test.ts   rejects unknown fields, bad types, hostile input
apps/api/src/repositories/
  mandate.ts        loadForAuthorization, loadVersion, insert, revoke
  mandate.test.ts   integration, incl. the one-query assertion
apps/api/src/audit/
  canonical.ts      canonical JSON + sha256
  canonical.test.ts key order, nesting, unicode, rejection cases
  writer.ts         appendAuditEvent() with the advisory lock
  writer.test.ts    chain correctness under concurrent appends
apps/api/src/providers/
  bank-lookup.ts    BankLookupProvider + Razorpay + Static implementations
  bank-lookup.test.ts  timeout and degradation behaviour
apps/api/src/routes/
  mandates.ts       the six endpoints
  mandates.test.ts  end-to-end via app.inject()
apps/api/src/middleware/
  admin-auth.ts     X-ATL-Admin-Key check
apps/api/src/db/migrations/
  0006_consent.sql  consent_ref, consent_at on mandate_versions (NOT NULL)
docs/API.md         endpoint reference
```

**Note on migration 0006.** Adding `NOT NULL` columns with no default to a
table that already has rows is impossible, and the usual three-step workaround
— add nullable, backfill with `UPDATE`, then `SET NOT NULL` — is **blocked by
our own append-only trigger**, which refuses the backfill.

Three ways out, and the choice depends on whether the existing rows are real
evidence:

1. `ADD COLUMN ... NOT NULL DEFAULT '<something>'` — works without a table
   rewrite in Postgres 11+, but it would stamp a **fabricated consent
   reference** onto historical rows. Rejected: inventing evidence is the one
   thing this project must never do.
2. Nullable columns plus a grandfather `CHECK` (`created_at < '<cutover>' OR
   consent_ref IS NOT NULL`). Honest, and the correct answer against real data
   — pre-existing rows are visibly exempt rather than silently backfilled.
3. Drop and re-migrate, because the only existing rows are regenerable seed
   fixtures.

We take **(3)**, since our 8 existing versions are seed data. But (2) is what
we would do against real data, and it is worth knowing *why* the textbook
three-step is unavailable to us: we deliberately made the table
unbackfillable.

## 7. How we test it

| Test | Asserts | Failure it prevents |
|---|---|---|
| DTO rejects unknown fields | `strict()` schema errors | a typo'd field silently ignored, so a limit the caller set never applies |
| DTO rejects a rupee float where paise expected | type error | ₹2000.5 becoming 2000 paise (₹20) |
| `toDomain` rejects incoherent terms | throws | a mandate the engine cannot evaluate |
| boundary values on every limit | `==`, `+1`, `-1` behave | off-by-one in the rule that matters most |
| `loadForAuthorization` returns the **current** version | version = MAX | authorizing against stale terms |
| `loadVersion(id, 1)` after v3 exists | returns v1's numbers | **the product guarantee**: a past decision stops being explainable |
| `loadForAuthorization` issues exactly one query | query count = 1 | an N+1 on the hot path |
| empty allowlist loads as `[]`, not null | array shape | "no merchants" read as "all merchants" — deny-by-default broken |
| revoke twice | second attempt rejected | a revocation that appears to succeed twice |
| canonical JSON: key order irrelevant | same hash for reordered keys | the chain breaking on a library upgrade |
| canonical JSON: nested objects, arrays, unicode, `-0`, big ints | stable output | subtle hash instability |
| canonical JSON rejects `undefined`/`NaN`/`Infinity` | throws | silently dropped fields inside hashed evidence |
| audit chain links correctly | `hash(n).prev == hash(n-1)` | an unverifiable chain |
| **concurrent appends** (N at once) | all succeed, one unbroken chain, no forks | the no-fork index rejecting a legitimate append |
| bank lookup timeout | mandate still created, fields null, degradation recorded | a third party being able to block mandate creation |
| bank lookup provider is not called on any authorization path | zero calls | a hot-path dependency sneaking in |
| endpoints without the admin key | 401 | unauthenticated mandate mutation |
| a version with no `consent_ref` | `NOT NULL` violation (23502) | terms changed without recorded consent |
| a version with a blank `consent_ref` | `CHECK` violation + constraint name | consent satisfied by an empty string |
| creating a mandate without consent via the API | 400 before any insert | a confusing database error surfacing to a caller |

## 8. Security notes

**Threat:** someone raises a mandate's spending authority without the user
agreeing to it.
**Vulnerability:** if `POST /versions` accepts arbitrary terms with no consent
step, a compromised dashboard session or an over-scoped caller could raise a
limit and then spend against it.
**Mitigation:** `consent_ref` and `consent_at` are `NOT NULL` on every version,
so the database refuses a version without them. The row is immutable, so the
change is permanently visible, and an audit event records it.
**Why this one:** there is no code path that can skip consent, because there is
no code involved — the alternative (classify the diff and gate only the
dangerous direction) puts a function in the security path, and a bug in that
function is a silent authority increase. Fail-closed by construction beats
fail-closed by correct implementation.

**Threat:** consent is claimed but never actually obtained.
**Vulnerability:** in Phase 3 `consent_ref` is a caller-supplied identifier —
the database enforces that *something* is recorded, not that a human agreed.
**Mitigation:** none available yet; a real consent flow needs the Phase 9 UI.
**Why this matters:** it must be labelled as a limitation in the Phase 10 DPDP
register rather than presented as end-to-end consent capture. Writing this down
now is the mitigation — an unrecorded gap becomes an overclaim later.

**Threat:** unauthenticated mutation of mandates.
**Vulnerability:** Phase 3 predates the real auth model, so these endpoints
would otherwise be open.
**Mitigation:** a shared admin key checked with `crypto.timingSafeEqual`,
required in production by config, plus binding to `127.0.0.1` in development.
**Why this one:** it is not the final answer, but shipping an unauthenticated
mutation endpoint — even locally — normalises exactly the wrong default. Phase 5
replaces it with per-agent Ed25519 and per-user sessions.

**Threat:** untrusted input reaching the domain or the database.
**Mitigation:** Zod `strict()` at the boundary (unknown fields are an error,
not ignored), parameterised queries everywhere, and branded constructors that
validate.
**Why:** the query plan is fixed before parameter values arrive, so a value can
never become SQL syntax. Rejecting unknown fields turns a client typo into a
400 instead of a silently-ignored setting.

**Threat:** a hostile or huge payload inside a hashed audit event.
**Vulnerability:** `payload` is JSONB and is what we hash; an enormous or
deeply nested object could exhaust memory during canonicalisation.
**Mitigation:** cap payload size and nesting depth before hashing; reject
rather than truncate.
**Why:** truncating changes what the hash covers, which would make the evidence
subtly wrong — worse than refusing it.

**Threat:** PII leaking into audit payloads.
**Vulnerability:** the easy thing is to dump the whole request into `payload`.
**Mitigation:** payloads are built from an explicit allowlist of fields, never
by spreading an object; the logger's redaction list already covers the
transport side.
**Why:** an explicit allowlist fails closed — a new field is absent until
someone adds it deliberately.

**Threat:** SSRF or hang via the IFSC lookup.
**Mitigation:** a fixed host (no caller-supplied URL), a 2s timeout, no
retries on the create path, and IFSC format validated before the call.
**Why:** the caller controls only a validated 11-character code, and the
timeout bounds the blast radius of the dependency being slow.

## 9. What happens at scale

| Volume | What breaks first | Fix |
|---|---|---|
| 10 merchants | nothing | — |
| 10k mandates | `loadForAuthorization` — fine, it is two indexed lookups | — |
| high write rate | **the audit chain's advisory lock**: appends to one chain are serial, so throughput is bounded by one insert at a time | shard by `chain_id` (per merchant), which the schema already supports; verification then covers a set of chains rather than one |
| 10M audit events | verification is O(n) — you cannot walk 10M rows in an HTTP request | Merkle tree with periodically signed checkpoints; verify a range against a checkpoint (immudb, Trillian) |
| many versions per mandate | `MAX(version)` stays cheap on the `(mandate_id, version DESC)` index | — |
| bank lookups at signup rate | third-party rate limits | cache by IFSC (bank branch data is nearly static); the cold-path-only rule already keeps it off the hot path |

The audit lock is the interesting one: it is a deliberate trade of throughput
for an unforgeable ordering, and the mitigation (more chains) is a
partitioning problem rather than a redesign.

## 10. What I learned

*(after the phase)*

## 11. Mistakes made & why

*(recorded as they happen, while the reasoning is still recoverable)*

**1. Assumed an array of a custom DOMAIN type would parse like `text[]`.**
`blocked_mccs` is `mcc_code[]`. node-postgres has no parser registered for
that OID, so it returned the raw Postgres literal `"{5921,7995}"` as a
**string**. The repository then iterated it as characters, and the domain
constructor rejected `"1"`, `","`, `"7"`, `"9"`, `"}"` as invalid MCCs -
eleven tests failing with a bizarre error message.

Confirmed by probe rather than by guessing: `mcc_code[]` returns a string,
`text[]` returns an array, `mcc_code[]::text[]` returns an array. Fixed by
casting in the SELECT.

The interesting part is *why the cast is the right fix* and not merely the
easy one. The alternative is registering a parser for the domain array's OID -
but that OID (17454 here) is assigned when `CREATE DOMAIN` runs, so it
**differs per database**. A hardcoded parser would work locally and break on a
fresh deployment, which is a far worse failure than the one we started with.

*Why it happened:* I introduced a domain type in Phase 2 for its per-element
validation and never considered how the driver would read it back. A schema
decision had a client-side consequence I did not follow through.
*Lesson:* when you add a custom type to the schema, immediately check what the
driver does with it on the way out. And the round-trip fidelity test - written
to catch "a value mangled by array or date conversion" - earned its place
within a minute of existing. Assertions on *every* field, not just the one
under test, are what turn a silent corruption into a loud failure.

## 12. Open questions / debt

- **Consent is a reference, not a ledger.** We store `consent_ref` +
  `consent_at`, not a full record of grants and withdrawals over time. The
  Phase 10 DPDP register must describe what we actually have.
- **No user-facing consent UI** until Phase 9, so Phase 3's consent is an API
  field a caller supplies. The database enforces that a reference is recorded,
  not that a human agreed. Honest labelling required — see §8.
- **IDs are unbranded** by decision, so a wrong-type id is caught by the
  database rather than the compiler. Revisit if it ever actually bites.
- **`mandate_versions.signature` stays null.** Signing terms cryptographically
  arrives with key handling in Phase 5/6.
- **No pagination** on version history. Fine at single digits; needed before
  any mandate accumulates hundreds.
- **`EXPLAIN ANALYZE` still owed** on `loadForAuthorization` and the Phase 2
  spend query, with real row counts.
