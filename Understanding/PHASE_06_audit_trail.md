# Phase 6 — The Tamper-Evident Audit Trail

**Status:** DONE · **Started:** 2026-09-05 · **Finished:** 2026-09-05
**Result:** streaming verifier, signed checkpoints, three endpoints, a working
tamper demo, 499 tests. One real false-negative bug found by a test.

> Sections 1–9 before any code. Sections 10–12 after.

---

## 1. What we are building

**Proof.** The hash chain already exists — `audit/writer.ts` has been appending
to it since Phase 3, and it now carries every authorization decision. What it
does not yet have is anything that *checks* it.

Phase 6 adds four things:

1. A **verifier** that walks a chain, recomputes every hash, and reports the
   first row where the recorded value and the computed value disagree.
2. **`GET /v1/audit/verify`**, so integrity is a fact anyone can request rather
   than a claim in a README.
3. **Signed checkpoints** — periodic anchors that make a *whole-chain rewrite*
   detectable, not just a single-row edit.
4. A **tamper demonstration** that edits a real historical event and shows
   verification failing and naming the row.

## 2. Why now

An audit trail nobody verifies is a log file with extra ceremony. Until this
phase, "tamper-evident" is an assertion — and `CLAUDE.md` §4 is explicit that
claimed properties must be proven by something that fails when the property
stops holding.

It also has to come before the dashboard (Phase 8), because the integrity
banner and the tamper button are screens over this endpoint.

## 3. How it works

Each row commits to its predecessor:

```
  seq 1            seq 2                    seq 3
┌──────────┐     ┌──────────────────┐     ┌──────────────────┐
│ prev NULL│◄────┤ prev = hash(1)   │◄────┤ prev = hash(2)   │
│ hash  A  │     │ hash  B          │     │ hash  C          │
└──────────┘     └──────────────────┘     └──────────────────┘

hash = sha256(canonicalJson({
  v, chainId, id, eventType, occurredAt, actorKind, actorId,
  subjectKind, subjectId, requestId, mandateId, payloadHash, prevHash
}))
```

**The hash covers the whole record, not just the payload.** If it covered only
`payload`, someone could change `actor_id` from `agt_impostor` to
`agt_grocery_shopper` and the chain would still verify — the attribution, which
is the part a regulator cares about most, would be unprotected.

Edit any field of event 2 and its recomputed hash no longer matches the stored
one. Recompute the stored one to cover the edit, and now event 3's `prev_hash`
points at a hash that no longer exists. **A single edit forces rewriting every
subsequent row**, which is the property that makes the chain useful.

```
verify(chain)
  │  read rows in seq order
  ├─ recompute hash(payload)          → does it match payload_hash?
  ├─ recompute hash(whole record)     → does it match hash?
  ├─ does prev_hash equal the previous row's hash?
  ├─ is there exactly one genesis (prev_hash IS NULL)?
  └─ do the signed checkpoints still match the rows they anchor?
       │
       ▼
  { status: 'intact' | 'broken', eventsChecked, firstBreak: { seq, kind } }
```

## 4. Concepts I need first

**Hash chain vs Merkle tree.** A chain is linear: verifying row *n* requires
reading rows 1..*n*. A Merkle tree lets you prove one leaf with a log-sized
path. The tree is better at scale and much harder to explain and to get right;
we choose the chain for the MVP and record what would change (§9).

**Canonical serialisation.** `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same
object and different bytes. Hashing must therefore sort keys and reject values
whose serialisation is ambiguous (`undefined`, `NaN`, `Date`, `bigint`,
cycles) rather than coerce them. `audit/canonical.ts` already does this — and
*rejecting* rather than coercing matters, because a silent coercion changes the
bytes and therefore the hash.

**Tamper-EVIDENT is not tamper-PROOF.** A hash chain detects modification. It
does not prevent it. Someone with database superuser rights can rewrite every
row *and* every hash, and the chain will verify perfectly. This is our claim
ceiling and it never moves.

**What a checkpoint buys.** A signed checkpoint records "at seq N, the head hash
was H", with an HMAC we can verify. To fake history *before* a checkpoint, an
attacker must now also forge the checkpoint's signature — which needs the
signing secret, not just database access. It raises the bar from "database
write" to "database write **and** secret exfiltration". It does not eliminate
the threat, and we must not pretend otherwise.

**Why external anchoring is the real answer, and why we are not doing it.**
Publishing the head hash somewhere we do not control (a public transparency log,
another organisation, a newspaper) is what makes rewriting genuinely impossible
rather than merely harder. That is a Phase-2-of-the-company problem: it needs a
counterparty. We record it as the production path.

## 5. Design choices & tradeoffs

**1 — The verifier imports `computeEventHash` from the writer.**
Not a second implementation of "how we hash a record". Two implementations
would eventually disagree about some edge case, and **the disagreement would
look exactly like tampering** — the worst possible false positive for this
feature. One function, exported since Phase 3 precisely for this.

**2 — Verification streams; it does not load the chain into memory.**
A `for await` cursor over rows in `seq` order. Loading 10 million events to
verify them is an out-of-memory error waiting for a Tuesday.
*Rejected:* `SELECT *` into an array — simpler, and it caps the feature at
whatever fits in RAM.

**3 — The endpoint reports the FIRST break, not every break.**
After one broken link, every subsequent row also fails; listing them all would
produce a million-line response describing one edit. The first break is the
actionable fact. We still report how many events were checked before it.
*Tradeoff:* two independent tampering events look like one. Acceptable —
a second verification run after repair finds the next one.

**4 — Checkpoints are HMAC-signed with a separate secret.**
`AUDIT_CHECKPOINT_SECRET`, not `VOUCHER_SIGNING_SECRET`. Different lifetimes,
different blast radius, different rotation schedules: a leaked voucher secret
lets someone mint a payment token, and it must not *also* let them forge
history. **Key separation by purpose** is close to free and prevents one
compromise from becoming two.

**5 — The tamper demo runs as the OWNER, and says so loudly.**
`atl_app` cannot UPDATE `audit_events` — the grant is revoked *and* a trigger
refuses. So the demo must deliberately connect as the database owner, which is
honest: the threat we detect is a **privileged insider**, not an application
bug. A demo that pretended the app could do it would be theatre.

**6 — Read endpoints require the admin key.**
The audit trail contains merchant names, amounts, mandate ids and (in
`user_intent`) personal data. Phase 3 left reads open; this phase does not add
new open ones. Full RBAC is Phase 9.

**7 — One new migration, `0007_audit_checkpoints.sql`.**
Phase 5 needed none. This one genuinely does: there is nowhere to put a
checkpoint. It is append-only like everything else in the evidence path.

### Where the LLM is, in this phase

Nowhere. Again. Verification is arithmetic.

## 6. Files created/modified

```
apps/api/src/
  audit/verifier.ts        streaming chain verification + checkpoint checks
  audit/verifier.test.ts
  audit/checkpoint.ts      mint/verify signed checkpoints
  audit/checkpoint.test.ts
  repositories/audit.ts    chain listing, cursor, checkpoint reads/writes
  routes/audit.ts          GET /v1/audit/verify, /events, POST /checkpoint
  routes/audit.test.ts
  demo/tamper-demo.ts      the buildathon moment, as the owner
  db/migrations/0007_audit_checkpoints.sql
  config.ts                + AUDIT_CHECKPOINT_SECRET
```

## 7. How we test it

The rule from `CLAUDE.md` §4 is the whole point of this phase.

| Claim | The test that would fail |
|---|---|
| An unmodified chain verifies | seed events, verify, expect `intact` |
| A changed payload is caught | UPDATE one `payload` as owner, expect `broken` at that seq |
| A changed ACTOR is caught | UPDATE `actor_id` — proves the hash covers the whole record, not just the payload |
| A changed timestamp is caught | UPDATE `occurred_at` |
| A recomputed hash is still caught | update payload **and** `payload_hash` **and** `hash` — the next row's `prev_hash` now dangles |
| A deleted event is caught | delete a middle row as owner; the link breaks |
| A forged genesis is caught | insert a second `prev_hash IS NULL` row — the unique index refuses it |
| A fork is caught | two rows with the same `prev_hash` — the unique index refuses it |
| Checkpoints detect a full rewrite | rewrite the whole chain consistently, then verify checkpoints |
| A forged checkpoint is caught | edit a checkpoint's `head_hash`, expect signature failure |
| The app role STILL cannot tamper | already proven in `roles.test.ts`; asserted again here |
| Verification is streaming | assert peak rows held, not total rows |

**The positive control this phase needs:** a verifier that always returns
`intact` would pass a naive "the chain verifies" test. So every tamper test is
paired with a preceding assertion that the same chain verified *before* the
edit, and the demo prints both.

## 8. Security notes

| Threat | Detected? | By what |
|---|---|---|
| Application edits an old event | Prevented | revoked grant + `reject_mutation` trigger |
| Application deletes an event | Prevented | revoked grant + trigger |
| Application truncates the table | Prevented | TRUNCATE needs ownership |
| **Owner edits one event** | **Detected** | hash mismatch at that seq |
| **Owner edits an event and its hash** | **Detected** | next row's `prev_hash` dangles |
| **Owner rewrites the entire chain** | **Detected** *if a checkpoint predates it* | checkpoint signature |
| Owner rewrites the chain **and** has the checkpoint secret | **NOT detected** | — |
| Owner drops and recreates the table | Detected as an empty/short chain vs checkpoints | — |
| Two divergent histories | Prevented | `audit_events_no_fork_idx` |
| A second genesis | Prevented | `audit_events_single_genesis_idx` |

**The honest bottom line, which goes in the README and the dashboard:** we
detect modification, we do not prevent it. An attacker holding both database
superuser rights and the checkpoint signing secret can rewrite history
undetectably. External anchoring is the fix, and it is not in this MVP.

## 9. What happens at scale

Verifying a 10-million-event chain reads 10 million rows. At MVP volume that is
milliseconds; at production volume it is a batch job, not an HTTP request.

The order of change, when measurement says so:
1. **Verify from the last checkpoint**, not from genesis — turning O(n) into
   O(events since the last checkpoint), which is the main reason checkpoints
   earn their place beyond the security argument.
2. **Per-merchant chains** (the `chain_id` column exists for this), so one
   merchant's verification does not read everyone else's events.
3. **Time-partition** `audit_events`, and move the seven-year retention tier to
   WORM object storage.
4. **A Merkle tree** only if single-event proofs are actually needed by
   somebody — a real requirement, not an aesthetic one.

---

## 10. What I learned

**A hash chain proves consistency, not authenticity.** This is the sentence the
whole phase turns on, and I did not properly understand it before writing the
code. Every row committing to its predecessor means *you cannot change one row*
— but someone who rewrites *every* row and *every* hash produces a chain that
verifies perfectly, because there is nothing outside the chain to compare it to.
The chain answers "is this internally consistent?", never "is this what
happened?". Checkpoints are the first thing in the system that answers the
second question, and even they only push the requirement out to "and you must
also steal a secret".

**Defence in depth turned out to be deeper than the design claimed.** I expected
the tamper tests to work as the database owner, because the *grant* is what
`atl_app` lacks. Every one of them failed:

```
error: public.audit_events is append-only; UPDATE is not permitted
```

`BEFORE UPDATE` triggers fire for the table owner too. To edit a past event an
attacker must first run `ALTER TABLE … DISABLE TRIGGER`, which needs ownership
and which PostgreSQL logs. That is a genuinely higher barrier than "owner can
edit rows", and I only learned it because the test refused to pass. **The demo
is stronger for it** — it now shows two refusals before the tamper succeeds.

**Streaming is a design constraint, not an optimisation.** Verifying by loading
the chain into an array works perfectly until the chain is bigger than memory —
which is exactly the point at which the feature matters. The verifier holds two
rows and the handful of hashes that checkpoints actually anchor. Keeping *every*
hash "just in case" would have quietly undone the whole thing.

**Keyset pagination, and why OFFSET is a trap here.** `OFFSET 10000` makes the
database scan and discard ten thousand rows, so a "streaming" loop becomes
accidentally O(n²). Worse for an append-only table: rows arriving during a long
verification shift the offsets, so pages skip and repeat. `WHERE seq > $last` has
neither problem.

**Reporting only the first break is a product decision, not laziness.** After one
broken link every subsequent row fails. A response listing a million broken rows
describes *one* edit and is unreadable. The first break plus "1 of 5 events
verified before the damage" is the actionable form.

**Key separation costs one environment variable.** `AUDIT_CHECKPOINT_SECRET` is
not `VOUCHER_SIGNING_SECRET`, and config refuses to boot if they match. Leaking
the voucher key lets someone mint a payment token; it must not *also* let them
forge history. The refuse-if-equal check matters more than the second variable
does — without it, someone would eventually paste the same value into both and
we would have key separation on paper and none in fact.

**Verify before you anchor.** Signing a checkpoint over a chain that already
fails verification would give a forged history *our own signature*. It would
launder the tampering rather than detect it. The endpoint returns 409 instead.

## 11. Mistakes made & why

**1. A false negative that would have destroyed the whole feature.** My first
`checkOneCheckpoint` returned `unreachable` when the anchored event was missing,
and `unreachable` did not mark the chain broken. So **deleting the entire audit
trail reported `intact`.** The single worst possible bug in a verifier: the more
complete the destruction, the cleaner the report.

It was caught by the full-rewrite test — a test I had written mainly to
demonstrate a feature, which instead found a bug. `unreachable` now means one
thing only: *we could not check this* (no secret configured). A missing anchored
event is always `head_mismatch`. **Statuses that mean "unknown" must never be
reachable from a condition that means "bad".**

**2. A test that could not fail, then a test that could not fail reliably.**
The "second checkpoint at the same position" test went through three versions:

- *Call the endpoint twice* → 201 twice. Creating a checkpoint appends an
  `AUDIT_CHECKPOINT_CREATED` event, so the head advances and the second anchor
  is at a new position. Correct behaviour; wrong test.
- *Fire two concurrent requests* → 201 twice. `appendAuditEvent` holds a
  per-chain advisory lock, so the second request read a head the first had
  already advanced. **A test that depends on winning a race is a test that
  fails on a different machine.**
- *Pre-insert an anchor at the current head, then call the endpoint* →
  deterministic 409.

Same family as PHASE_04's purity check and PHASE_05's duplicate-header test.
Three phases, three versions of one lesson: **construct the condition, do not
hope for it.**

**3. I nearly claimed more than the system does.** An early draft of the
response called the status `verified`. It is `intact`, and every response,
including the successful one, carries the `limitation` string. A green banner
that can be screenshotted without its caveat is how "tamper-evident" becomes
"tamper-proof" in somebody's pitch deck.

## 12. Open questions / debt

- **No external anchoring.** The honest fix for a full rewrite is publishing the
  head hash somewhere we do not control. That needs a counterparty and is
  therefore out of scope for an MVP — but it is the *real* answer and is named
  as such in the response, the docs and the demo.
- **Verification always starts at genesis.** `streamChain` accepts `fromSeq` and
  checkpoints record a verified position, so resuming from the last anchor is a
  small change. Not done because at MVP volume it is not measurable, and I did
  not want an unmeasured optimisation in the security-critical path.
- **No scheduled checkpointing.** Anchors are created by an admin calling the
  endpoint. A cron job every N events or every N hours is Phase 9.
- **`hash_algorithm` is recorded but never read.** The column exists so an
  algorithm migration is a data change with an audit trail; the verifier assumes
  sha256. Reading it is a one-line change when a second algorithm exists.
- **Checkpoint retention is unbounded.** `listCheckpoints` loads all of them on
  every verification. Fine at hundreds; wrong at millions.
- **One chain.** `chain_id` exists and is used by tests, but production would
  want per-merchant chains so one merchant's verification does not read
  everyone else's events.
