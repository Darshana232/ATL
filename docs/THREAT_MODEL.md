# Threat Model

STRIDE across the three trust zones. Every mitigation names **the test that
proves it**, because a mitigation nobody can demonstrate is a paragraph.

**Last reviewed:** 2026-09-05 · Phase 9

---

## The zones

```
ZONE 1 — UNTRUSTED                    ZONE 2 — TRUSTED           ZONE 3 — EVIDENCE
agent runtime, LLM, MCP client        policy engine, payments    audit chain
merchant catalog text                 vouchers, mandates         checkpoints
browser                               sessions, roles            reports

   cannot import the engine              decides                    append-only
   cannot reach a provider               mints vouchers             hash-chained
   cannot mint a voucher                 enforces limits            two barriers
   can only ASK, over signed HTTP
```

**The single most important property:** Zone 1 reaches Zone 2 only through a
signed HTTP request, and Zone 2 is the only thing that can mint a voucher. A
fully compromised agent can ask. It cannot pay.

---

## S — Spoofing

| Threat | Mitigation | Proven by |
|---|---|---|
| Forged agent request | Ed25519 signature over a canonical string; we store only public keys | `auth/signing.test.ts`, `routes/authorize.test.ts` — tampered body, wrong key, another agent's key id |
| Agent uses another agent's mandate | `MANDATE_AGENT_MATCH` rule 1; `attempt.agentId` comes from the signature, never the body | `policy/rules.test.ts`, `routes/authorize.test.ts` |
| Stolen voucher used by another agent | The agent id is inside the MAC and re-matched to the caller | `routes/payments.test.ts` |
| Forged webhook | HMAC-SHA256 over the **raw body** | `routes/webhooks.test.ts` — forged, unsigned, altered-after-signing |
| Operator impersonation | scrypt password + revocable session; the cookie holds the token, the table holds its SHA-256 | `routes/auth.test.ts`, `auth/password.test.ts` |
| User enumeration by timing | The no-such-user path does the same scrypt work against a dummy hash; one message for every failure | `auth/password.test.ts`, `routes/auth.test.ts` |
| **Stolen agent private key** | **NOT MITIGATED.** The holder becomes that agent — but is still confined to that agent's mandates and every limit in them. That confinement is the entire argument for mandates. | — |

## T — Tampering

| Threat | Mitigation | Proven by |
|---|---|---|
| Request body altered in transit | Body SHA-256 is inside the signed string | `routes/authorize.test.ts` — one paisa is enough |
| Voucher claims edited | Amount, merchant, agent, expiry and verdict are all inside the MAC | `voucher/voucher.test.ts` |
| Application edits an audit event | Grant revoked **and** `reject_mutation` trigger | `db/roles.test.ts`, `db/schema.test.ts` |
| Application truncates evidence | TRUNCATE requires ownership; statement-level trigger as well | `db/roles.test.ts` |
| **Owner edits one event** | Detected — hash mismatch at that seq | `audit/verifier.test.ts` |
| **Owner edits an event and re-hashes it** | Detected — the next row's `prev_hash` dangles | `audit/verifier.test.ts` |
| **Owner rewrites the whole chain** | Detected **if a checkpoint predates it** | `audit/verifier.test.ts` |
| Owner rewrites the chain **and holds the checkpoint secret** | **NOT MITIGATED.** External anchoring is the fix and is not in this MVP (gap ATL-C24). | — |
| Report body edited after review | `body_hash` immutable by trigger | `routes/reports.test.ts` |
| Cart altered between authorize and pay | The authorized amount is what the voucher permits, re-matched at redemption | `routes/payments.test.ts` |

**Note (Phase 6 finding):** the append-only trigger fires **for the table owner
too**. A privileged insider must first `ALTER TABLE … DISABLE TRIGGER` —
owner-only DDL that PostgreSQL logs. The barrier is higher than the original
design claimed. Demonstrated by `npm run demo:tamper`.

## R — Repudiation

| Threat | Mitigation | Proven by |
|---|---|---|
| "I never authorised that" | Every decision stores the mandate version, the spend snapshot, the risk signal and all 13 rule evaluations | `routes/authorize.test.ts` |
| "That wasn't my agent" | Signature verification; the credential fingerprint is in the audit payload | `routes/authorize.test.ts` |
| "Nobody ran that report" | `REPORT_GENERATED` and `REPORT_REVIEWED` events carry the **verified** operator id | `routes/auth.test.ts` |
| "The rules were different then" | `engine_version` on every decision; mandate versions immutable | `policy/engine.test.ts` |
| Failed auth leaves no trace | `AGENT_AUTH_REJECTED` in the chain; forged webhooks recorded with `signature_verified = false` | `routes/authorize.test.ts`, `routes/webhooks.test.ts` |
| **Reading evidence is not recorded** | **GAP.** Report *generation* is audited; report *viewing* is not. | — |

## I — Information disclosure

| Threat | Mitigation | Proven by |
|---|---|---|
| Stack traces or SQL in responses | 5xx bodies are opaque; only a `requestId` is returned | `routes/health.test.ts`, `routes/authorize.test.ts` |
| Secrets in logs or config errors | `config.ts` never echoes a value; pino redacts centrally; `describeConfig` reduces secrets to booleans | `config.test.ts` |
| Probing to map auth state | Missing / unknown / revoked / suspended / bad-signature all return one 401 body | `routes/authorize.test.ts` |
| Timing side channels | `timingSafeEqual` on every secret comparison, lengths compared first | `voucher.test.ts`, `checkpoint.test.ts`, `password.test.ts` |
| Personal data over-collected | Schema minimisation: nowhere to put a full phone number or unmasked VPA | `db/schema.test.ts`, DPDP register |
| Evidence readable by anyone | Console, audit and report endpoints require a session with a role | `routes/auth.test.ts` |
| Session theft via XSS | `HttpOnly` cookie — script cannot read it | `routes/auth.test.ts` |
| Admin key in the browser bundle | No `NEXT_PUBLIC_` prefix, so Next.js refuses to expose it | build-time |

## D — Denial of service

| Threat | Mitigation | Proven by |
|---|---|---|
| Unbounded request bodies | 1 MiB body limit, stated explicitly | `server.ts` |
| Agent request floods | 120/min per **authenticated agent** | `middleware/rate-limit.test.ts` |
| Credential stuffing | 10/min per IP on login, plus lockout after 5 failures | `routes/auth.test.ts` |
| Rate limiter as a DoS vector | Limits are keyed on the **authenticated** identity, so A cannot exhaust B's budget; the limiter runs **after** authentication | `middleware/rate-limit.test.ts` |
| Limiter memory exhaustion | Window map is capped at 10,000 keys with eviction | `middleware/rate-limit.test.ts` |
| Unbounded dashboard queries | Every list capped server-side at 200 | `routes/console.test.ts` |
| Slow payment provider | Explicit timeout; **fails closed** — never records `captured` on a timeout | `providers/payment.test.ts` |
| Lock contention | The mandate row lock serialises **one mandate**; different mandates never contend | `repositories/spend.test.ts` |
| **Horizontal scaling defeats the limiter** | **KNOWN.** In-process counters mean N instances allow N× the limit. A shared store is the fix. | — |

## E — Elevation of privilege

| Threat | Mitigation | Proven by |
|---|---|---|
| **Prompt injection → payment** | The agent's *authority* is bounded, not its obedience. An injected agent can only ask. | `agent/injection.test.ts` — the model **obeys** and still cannot pay |
| Agent calls an ungranted tool | Not offered **and** refused if called | `agent/tools.test.ts`, `agent/injection.test.ts` |
| Agent exceeds its mandate | 13 deterministic rules; risk can never override a BLOCK | `policy/rules.test.ts` |
| Voucher replayed | `payments.voucher_jti UNIQUE` — a database fact, not a lookup | `routes/payments.test.ts` — concurrent redemption yields one row |
| Webhook replayed | `UNIQUE (provider, provider_event_id)` | `routes/webhooks.test.ts` |
| Request replayed | Timestamp window + `UNIQUE (agent_id, idempotency_key)` inside the signature | `routes/authorize.test.ts` |
| Viewer performs an admin action | Ranked roles; 403 with the required role named | `routes/auth.test.ts` |
| Application escalates in the database | `atl_app` has no DDL, no DELETE anywhere, no UPDATE on append-only tables | `db/roles.test.ts` |
| SQL injection | Every value is a bound parameter; ids validated at the boundary | `routes/authorize.test.ts` |
| **Shared admin key grants admin** | **ACCEPTED WEAKNESS.** Demoted, not removed: needed for non-interactive tooling. Logged loudly on every use, and `verifiedIdentity: false` is surfaced in the console. | `routes/auth.test.ts` |

---

## Accepted risks, in one place

Anyone quoting this system's security posture should read this list first.

1. **A stolen agent private key** makes the holder that agent — bounded by that
   agent's mandates.
2. **Database superuser + the checkpoint secret** can rewrite history
   undetectably. External anchoring is the fix (gap ATL-C24).
3. **The shared admin key** grants admin with no per-caller identity.
4. **In-process rate limiting** does not survive horizontal scaling.
5. **No encryption at rest** beyond whatever the filesystem provides
   (gap DP-GAP-04).
6. **No consent withdrawal** and **no automated retention/deletion**
   (gaps DP-GAP-01, DP-GAP-02).
7. **Evidence reads are not themselves audited.**
8. **The risk provider is a labelled simulation.** It is not fraud detection.
9. **The mandate rail is simulated.** Razorpay test mode is a real payment
   integration; the agentic mandate rail is our own design.

## What this model does not cover

Physical security, host and network hardening, supply-chain compromise of npm
dependencies, insider threat at the cloud provider, and social engineering. All
real; none addressed by this codebase.
