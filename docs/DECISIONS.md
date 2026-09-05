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

---

## ADR-0014 — Consolidate the roadmap from thirteen phases to nine
**Date:** 2026-09-05 · **Status:** accepted

**Decision.** The build plan is **nine phases** (1–9), plus a Phase 0 prologue
that was repository and documentation setup rather than product. Three pairs of
the old plan are merged; nothing is dropped.

| Old | New | Why the merge is coherent |
|---|---|---|
| 7 Payments + 8 Agent runtime | **7** | Both are adapter work on the *outside* of the trust boundary — one adapting to a payment rail, one to a language model. Neither is a demo without the other. |
| 9 Dashboard + 10 Reports | **8** | The reports *are* screens in the dashboard. Splitting them meant building the UI shell twice. |
| 11 Security + 12 Observability/deploy | **9** | One "make it shippable" pass: threat model, hardening, CI, observability, deploy, demo. |

**Context.** The thirteen-phase plan was written before any code and was shaped
by topic rather than by deliverable. Under buildathon time pressure the useful
unit is "a thing you can demonstrate", and three of the old phases were halves
of one demonstrable thing.

**Alternatives considered.** *Renumber all phases 1–9* — rejected: it would
invalidate every `PHASE_xx` reference in `docs/` and `Understanding/`, and the
completed phases would acquire numbers that no commit message uses. *Leave it at
thirteen* — rejected: the user asked for nine, and the merged shape is genuinely
the more honest description of the remaining work.

**Reasoning.** Phases 0–6 keep their original numbers, so every existing
reference remains correct and no completed work is renamed. Only the unbuilt
tail is reshaped, which is the part where reshaping costs nothing.

**Tradeoff.** Phases 7, 8 and 9 are each larger than a former single phase, so
"phase complete" is a coarser signal near the end of the project. Mitigated by
each phase file listing its steps individually, so progress is still trackable
below phase granularity.

**Production implication.** None. This is a planning artefact, not an
architectural one.

**Also recorded:** a plain-English companion documentation set was created at
`Concepts Learning and Understanding/` — 67 concept cards, one file per phase,
and a file-by-file codebase tour, written for a second-year CS reader who needs
to explain the system out loud. It is a third audience alongside `docs/` (how it
works) and `Understanding/` (why it works, in engineering depth).

---

## ADR-0015 — Ed25519 for agent requests, HMAC for the voucher
**Date:** 2026-09-05 · **Status:** accepted

**Decision.** Two different cryptographic schemes, chosen by asking *who needs
to verify*.

| Direction | Scheme | Rationale |
|---|---|---|
| agent → us | **Ed25519**, asymmetric. The agent holds the private key; `agent_credentials` stores only the public key. | Two parties, and one must not be able to impersonate the other. A complete dump of our database contains no secret capable of forging a request. |
| us → us (payment voucher) | **HMAC-SHA256**, symmetric, key in `VOUCHER_SIGNING_SECRET`. | One party mints *and* verifies. A shared secret is simpler and faster; asymmetric buys nothing. |

**Context and numbering.** An earlier draft planned an HMAC shared secret for
agents, stored as an argon2 hash. That does not work: verifying an HMAC requires
recomputing it, which requires the actual key. Hash-only storage is correct for
passwords (the client sends the secret and we compare hashes), not for request
signing. `0002_identity.sql` records this reasoning and cites "ADR-0014" —
written before ADR-0014 was taken by the roadmap consolidation. **That comment
means this ADR.** Applied migrations are immutable (ADR-0006), so the collision
is recorded here rather than edited away.

**The signing string.** `ATL-v1 \n METHOD \n path \n timestamp \n keyId \n
idempotencyKey \n sha256(body)`, newline-joined.

- **The body is hashed, not signed directly.** The signing string stays a fixed
  small size regardless of cart size, and the signature can be verified *before*
  JSON parsing. Authenticate first, interpret second — a parser is a far larger
  attack surface than a hash.
- **One field per line.** Concatenated without separators, `keyId` `"ab"` plus
  key `"cd"` and `"a"` plus `"bcd"` are identical bytes, so one signature would
  validate two different requests. Header values are constrained to printable,
  single-line ASCII so no field can contain the separator.

**Replay.** A ±5 minute timestamp window plus the existing
`UNIQUE (agent_id, idempotency_key)`. The idempotency key is *inside* the signed
string, so a replay carries the same key and returns the original decision
rather than producing a new one. **No nonce table is required** — the
idempotency constraint is the nonce store, and the timestamp window is what
keeps the set of keys we must remember finite.

**Alternatives considered.** JWT/JWS for both directions (rejected: a large
library and an algorithm-confusion history for two fixed, tiny use cases);
mutual TLS (rejected: correct, but certificate distribution is a project of its
own and it authenticates a *connection*, not a request); a nonce table
(rejected: a second mechanism for a problem the existing unique constraint
already solves).

**Production implication.** The voucher becomes an asymmetrically signed
capability token with the private key in an HSM/KMS, so a compromised payment
service can verify vouchers but not mint them. Neither the wire format nor the
architecture changes.

---

## ADR-0016 — A blocked authorization returns HTTP 200
**Date:** 2026-09-05 · **Status:** accepted

**Decision.** `POST /v1/authorize` returns **200** for `PASS`, `FLAG` *and*
`BLOCK`, with the verdict in the body. 401/400/404/409 are reserved for "we
could not decide".

**Reasoning.** The decision is the resource, and producing it *succeeded*. A
BLOCK is a recorded business outcome with a thirteen-rule breakdown attached,
not a transport failure — and a status code cannot carry that breakdown. Using
403 would also conflate "your request was malformed or unauthenticated" with
"the policy said no", which are different problems for a caller.

**The safety does not depend on the status code.** A BLOCK response carries
`voucher: null`. A client that ignores `verdict` entirely still cannot pay,
because there is no token to present to the payment service. Structural safety
beats conventional signalling.

**Alternatives considered.** 403 Forbidden (rejected: see above); 402 Payment
Required (rejected: it means "pay to proceed", which is not what happened);
409 Conflict (rejected: nothing conflicted).

**Tradeoff.** Several payment APIs do use 402/403 for a denial, so a careless
integrator could read 200 as "paid". Mitigated by the null voucher, by
`verdict` being a required top-level field, and by documenting it in `API.md`.

---

## ADR-0017 — The agent-identity check is a policy rule, not a route guard
**Date:** 2026-09-05 · **Status:** accepted

**Decision.** "Is the authenticated agent the one this mandate authorises?"
became `MANDATE_AGENT_MATCH`, rule 1 of the policy engine, and `ENGINE_VERSION`
moved from `engine-v1` to `engine-v2`.

**Reasoning.** It is a policy question — *was this permitted by this mandate?* —
and it belongs in the explainable breakdown with everything else. A 403 in the
route would leave no rule evaluation, no decision row and nothing to count, and
an agent probing other people's mandates is exactly the pattern a security
review wants to be able to count. Running it *first* also means the headline
reason is the identity failure rather than some later limit.

**The engine version bump is the mechanism working.** Decisions recorded under
`engine-v1` stay explainable against the twelve rules that actually ran; nobody
has to pretend a thirteenth was applied retroactively.

**Tradeoff.** A blocked identity check costs a decision row and thirteen rule
rows, where a 403 would cost nothing. That is the price of the evidence, and the
evidence is the product.

**Note.** `attempt.agentId` comes from signature verification and never from the
request body — otherwise the rule would compare a claim against a claim.

---

## ADR-0018 — Signed checkpoints over the audit chain, and their honest limit
**Date:** 2026-09-05 · **Status:** accepted

**Decision.** Add `audit_checkpoints` (migration 0007): periodic, HMAC-signed
anchors recording "at seq N, on this date, the head hash was H, over M events".
Signed with `AUDIT_CHECKPOINT_SECRET`, which **must differ** from
`VOUCHER_SIGNING_SECRET` — config refuses to boot if they match.

**The gap it fills.** A hash chain detects a *single* edit, because altering one
row breaks every hash after it. It does **not** detect a *consistent rewrite*:
someone with superuser rights can recompute every row and every hash, and the
result verifies perfectly. **A chain proves internal consistency, never
authenticity.** The checkpoint is the first thing in the system that remembers
what the head used to be, from outside the chain.

**The honest limit, stated everywhere this feature appears.** This raises the
bar from *"can write to the database"* to *"can write to the database **and**
exfiltrate a secret"*. It does not make the trail tamper-proof. Only anchoring
the head hash somewhere we do not control — a public transparency log, a
counterparty, a published notice — does that, and that needs a counterparty an
MVP does not have. **Our claim ceiling remains `tamper-evident`.**

**Why a separate key.** Different blast radius. Leaking the voucher secret lets
someone mint a payment token; it must not *also* let them forge history. The
refuse-if-equal check matters more than the second variable — without it,
someone eventually pastes one value into both and we have key separation on
paper and none in fact.

**Verify before anchoring.** `POST /v1/audit/checkpoint` returns 409 if the
chain does not currently verify. Signing a checkpoint over a broken chain would
give a forged history our own signature — laundering the tampering rather than
detecting it.

**Alternatives considered.** A Merkle tree (rejected for the MVP: better at
scale, materially harder to explain and to get right, and nobody yet needs
single-event proofs); asymmetric checkpoint signatures (deferred — the
production path, where a verifier can check anchors without being able to mint
them); blockchain anchoring (rejected: it is external anchoring with extra
steps, cost and marketing risk, and `CLAUDE.md` §6 forbids blockchain for
marketing).

**Also recorded — a finding from building the tamper demo.** The append-only
`BEFORE UPDATE OR DELETE` trigger fires **for the table owner too**, not only
for `atl_app`. To edit a past event, an attacker must first
`ALTER TABLE … DISABLE TRIGGER`, which requires ownership and which PostgreSQL
logs. The barrier is higher than the original design claimed, and the demo now
shows both refusals before the tamper succeeds.

---

## ADR-0019 — Prompt injection is designed around, not defended against
**Date:** 2026-09-05 · **Status:** accepted

**Decision.** We do **not** attempt to detect or sanitise prompt injection as a
security control. The agent's **authority** is bounded, not its obedience.

**Context.** The agent reads text it did not write — product names,
descriptions, merchant names. Any of it can contain instructions. There is no
known reliable way to make a language model ignore them.

**Reasoning.** A sanitiser that works most of the time creates false
confidence, which is worse than none: everybody stops worrying about the case
it misses. So the assumption is that **the agent is fully compromised**, and
the design question becomes "what can a compromised agent actually do?" The
answer is: propose. It cannot import the policy engine, cannot reach a payment
provider, cannot mint a voucher, and cannot write an audit event. It can make
signed HTTP calls to the trusted zone, and the trusted zone says no.

**What we do anyway, labelled as mitigation rather than defence.** Untrusted
catalog text is length-bounded by a database `CHECK` and fenced in
`<merchant-supplied-text>` tags so the model is told plainly what is data. The
system prompt describes the model's real position. None of this is relied upon.

**Detection is for the report, never for the defence.** `runAgent` records
`injectionObserved` so a human can see hostile text passed through. It never
changes behaviour on that basis.

**How it is proven.** `agent/injection.test.ts` runs a deliberately credulous
mock model against a hostile product description that lives in the **seeded
catalog**, not in the test file. The agent obeys the injection, skips
authorization, and attempts a ₹9,999 payment at a liquor merchant. No money
moves. A test where the model *refuses* would prove Anthropic's safety training
works, not that our architecture does.

**Alternatives considered.** Input sanitisation as a control (rejected: see
above); an LLM-based injection classifier (rejected: a probabilistic gate in
front of a deterministic one, and ADR-0010's reasoning applies —
authorization must stay explainable); refusing to let agents read merchant text
at all (rejected: it is the product).

---

## ADR-0020 — One tool registry, two transports
**Date:** 2026-09-05 · **Status:** accepted

**Decision.** `agent/tools.ts` holds the only tool definitions and the only
authorization function. The in-process runtime and the MCP server (`mcp/server.ts`)
both call it. Neither reimplements the scope check.

**Reasoning.** A second implementation of "which tools may this agent call?" is
how a security boundary develops a hole: the two copies drift, and the one
nobody reviewed is the one that is wrong. Adding MCP should add a *transport*,
not a second policy.

**Two-sided enforcement, and only one side is a control.** An ungranted tool is
never offered (hygiene — a smaller prompt is a smaller attack surface) *and* is
refused when called (the control — a model can invent a tool name it was never
shown, and an injected one will). Shipping only the first would be hiding a
capability rather than removing it.

**Grants are read on every run and every tool listing, never cached.** A revoked
grant must take effect immediately; a cache would let a compromised agent keep a
capability we already removed, for as long as the TTL.

**Also recorded.** Three sensitive tools — `modify_mandate`,
`delete_audit_event`, `export_all_users` — are defined and granted to **nobody**.
A tool-level authorization demo with nothing dangerous in the catalogue proves
nothing. And `execute_payment` *is* granted, because it is not dangerous to
grant: it cannot move money without a voucher. Granting it makes the agent
useful; the voucher makes it safe, and those are different questions.

---

## ADR-0021 — Razorpay test mode is a real integration; the mandate rail is not
**Date:** 2026-09-05 · **Status:** accepted

**Decision.** `RazorpayTestProvider` calls the genuine `api.razorpay.com/v1`
test-mode API. `MockUpiProvider` remains the default and is labelled SIMULATED
on every row it writes.

**What is real and what is not, stated precisely.** Razorpay test mode gives
real API calls, real orders and real test payments, with no real money and no
full KYC — a genuine integration. The **agentic mandate rail** is not: Razorpay's
agentic-payments product is a live pilot with no public developer API
(RESEARCH_REALITY_CHECK item 1), so mandate authorization is our own design and
is simulated regardless of which provider executes the payment.

**A live key is refused at construction.** `rzp_live_…` throws. Moving real
money during a demonstration is the worst mistake this project could make, and
a check that runs before anything else is cheap insurance.

**Fail closed on a timeout.** A provider that does not answer within the budget
yields `failed`, never `captured`. On a payment path, *"we do not know"* must
never be recorded as *"money moved"*: a payment wrongly marked captured costs a
human hours of reconciliation; one wrongly marked failed costs a retry.

**Authorize and capture are separate because the rail makes them separate.**
Razorpay's order is the merchant-side half; a payment id only exists once a
customer pays, which an autonomous agent cannot do. So the payment stays
`authorized` and the **webhook** completes it — which is how it works in
production anyway.

**Honest gap.** No test-mode keys exist yet, so the Razorpay paths have never
run against the real API. The provider is written against the documented
contract and exercised with the mock. Until keys exist, nothing may claim we
have called Razorpay successfully.

---

## ADR-0022 — Control coverage must include controls we have NOT built
**Date:** 2026-09-05 · **Status:** accepted

**Decision.** The FREE-AI coverage report's in-scope set includes six controls
we have deliberately **not** implemented, each with the reason and where it is
planned. Coverage is reported as **20/26**, a ratio, never a percentage.

**Context.** The first implementation listed only controls already built and
returned **20/20 with zero gaps**. Every individual control was honest — real
evidence, real queries, stated limitations. **The dishonesty was in the
selection**, which no individual check could catch: the number was guaranteed
before a single query ran.

**Reasoning.** A coverage report over a self-selected set of successes is the
same species of claim as the research's "98.75% compliant", just with better
manners. A number that cannot move is not a measurement. Putting the gaps in
scope makes it one — and the gaps are rendered *above* the covered controls in
the UI, unsuppressed and not collapsible.

**A ratio, not a percentage.** "20/26" invites "which six?", which is the
question a compliance officer should be asking. "77%" invites nothing and
implies a denominator somebody else agreed to. FREE-AI is a committee framework
with no certifying authority, no audit scheme and no scoring methodology, so no
such denominator exists.

**Each control carries its own verification query.** If a later refactor removes
a control, its query stops returning rows and coverage drops by itself. Nobody
has to remember to update the report — and "remember to update the report" is a
control that fails silently.

**A failing query is not an empty one.** A control whose evidence query *errors*
reports `error` and is not counted: it means the thing we thought we were
measuring no longer exists in the shape we assumed, which is more alarming than
zero rows.

**Also recorded.** The six unbuilt controls are: consent withdrawal, RBAC for
human operators, rate limiting, external audit anchoring, independent fraud
detection, and **validation against real merchant requirements** — which states
plainly that no merchant interviews have taken place and that quotes in the
research folder appear to be fabricated (RESEARCH_REALITY_CHECK item 10).

---

## ADR-0023 — Honesty caveats are required response fields, not documentation
**Date:** 2026-09-05 · **Status:** accepted

**Decision.** Every compliance report response carries its caveat as a
**required field**, and every screen renders it unsuppressed. The standing
"demonstration implementation" disclaimer lives in the dashboard sidebar.

**Reasoning.** A caveat in a README gets separated from the number the first
time somebody screenshots a screen. Placement in the sidebar means it appears in
every screenshot of every screen, which is the only placement that actually
works. Making it a required field means an API consumer cannot receive the
figure without receiving the qualification.

**Concretely.** `/v1/reports/free-ai` carries "CONTROL COVERAGE, NOT A
COMPLIANCE SCORE"; `/v1/reports/str` carries "DRAFT — HUMAN REVIEW REQUIRED"
plus our non-registration with FIU-IND; `/v1/reports/dpdp` carries the phased
DPDP timeline and "no merchant is non-compliant today"; `/v1/audit/verify`
carries "TAMPER-EVIDENT, NOT TAMPER-PROOF" **including on success**, because a
green banner is exactly what ends up mislabelled.

**Tested negatively.** The suite scans report responses for `%` and the word
"compliant" and fails if either appears. Those tests exist to fail the moment
somebody "improves" the wording.

**Tradeoff.** The responses are wordier and the screens are less clean. Accepted:
`CLAUDE.md` §33 forbids presenting a simulated or unapproved system as a real
one, and a design that makes the caveat easy to crop is a design that removes it.
