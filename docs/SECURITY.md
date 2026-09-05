# Security

How to report something, and what we claim.

## Reporting

This is a **buildathon demonstration implementation**, not a deployed service.
There is no production system to compromise and no bounty. If you find
something, open an issue — and if it is a genuine vulnerability class rather
than a bug in a fixture, say so in the title.

## What we claim, precisely

| Claim | Status |
|---|---|
| A language model cannot authorise a payment | **Structural.** The agent runtime cannot import the engine, reach a provider, or mint a voucher. Proven by `agent/injection.test.ts`, where an injected agent obeys the attacker and still cannot pay. |
| The audit trail is **tamper-evident** | **Yes.** Never tamper-*proof*: a hash chain detects modification, it does not prevent it. |
| Payment authorization is deterministic and explainable | **Yes.** 13 rules, per-rule breakdown, reasons containing the numbers, `engine_version` recorded. |
| Razorpay integration | **Test mode only, and untested against the live API** — no test keys exist yet. The default rail is a labelled simulation. |
| The agentic **mandate** rail | **Simulated.** Razorpay's agentic-payments product is a live pilot with no public developer API. |
| RBI / NPCI / FIU-IND approval | **None.** No certification, no registration, no integration. |
| DPDP or FREE-AI compliance | **Not claimed.** We report *control coverage* with named gaps. |
| STR filing | **Cannot.** FIU-IND filing runs through FINnet by registered reporting entities. We produce a DRAFT for human review. |

## Controls, in one paragraph each

**Agent authentication.** Ed25519 signatures over a canonical, newline-separated
string covering method, path, timestamp, key id, idempotency key and a SHA-256
of the raw body. We store only public keys, so a database breach cannot forge a
request.

**Replay protection.** A ±5 minute timestamp window plus
`UNIQUE (agent_id, idempotency_key)`, with the idempotency key inside the
signature. One mechanism serves both retry-safety and replay defence.

**Payment authority.** A single-use, 60-second HMAC capability token naming one
amount at one merchant for one agent. Single use is enforced by
`payments.voucher_jti UNIQUE`, not by an application check.

**Human access.** Per-operator accounts with scrypt password hashes and ranked
roles (viewer < compliance < admin). Sessions are revocable immediately; the
cookie is `HttpOnly` and `SameSite=Lax`, and the table stores a SHA-256 of the
token rather than the token.

**Least privilege.** The service connects as `atl_app`: no DDL, no DELETE
anywhere, no UPDATE on any append-only table. Migrations run as the owner.

**Rate limiting.** 120/min per authenticated agent, 10/min per IP on login, and
account lockout after five failures.

**Secrets.** Three separate signing keys — voucher, audit checkpoint, webhook —
because a leak of one must not become a leak of the others. Config refuses to
boot in production without them, and refuses to accept the voucher and
checkpoint secrets being the same value.

## The full threat model

[`THREAT_MODEL.md`](THREAT_MODEL.md) — STRIDE across the three trust zones,
with every mitigation naming the test that proves it, and an explicit list of
**accepted risks**.
