# Phase 9 — Hardening and Shipping

**Status:** DONE · **Started:** 2026-09-05 · **Finished:** 2026-09-05
**Result:** RBAC, rate limiting, a threat model, lint, CI, and one demo that
tells the whole story. Coverage moved 20/26 → **22/26**. 671 tests.

> Sections 1–9 before any code. Sections 10–12 after.

---

## 1. What we are building

The pass that turns a working system into a shippable one, and closes the gaps
the coverage report has been naming out loud since Phase 8.

1. **Human authentication with roles** — closes gap **ATL-C22**. Replaces the
   shared admin key, and makes `createdBy` a *verified identity* rather than a
   claim. Also closes the mandate read endpoints Phase 3 left open.
2. **Rate limiting** — closes gap **ATL-C23**.
3. **A threat model** — STRIDE across the three trust zones, with every
   mitigation pointing at the test that proves it.
4. **ESLint, Prettier and CI** — the first automated gate this repo has had.
5. **Observability** — the ids already flow through the logs; make a request's
   whole life readable in one query.
6. **Deployment** — `docker-compose.yml` has been committed and never run since
   ADR-0004. Exercise it or say so plainly.
7. **One demo that tells the whole story.**

## 2. Why now

Because the coverage report *says so*. ATL-C22 and ATL-C23 are printed as gaps
on a screen a judge will look at, and the honest options are to fix them or to
keep them printed. Fixing two is better than printing four.

Everything else here is the difference between "it runs on my laptop" and "a
second engineer can run it, change it, and know when they broke it".

## 3. How it works

```
   BEFORE                              AFTER
   x-atl-admin-key                     Session cookie -> user -> role
   one shared secret                   argon2id password, per-user identity
   no rotation                         revocable sessions, expiry
   createdBy = a CLAIM                 createdBy = VERIFIED
   open mandate reads                  authenticated, role-gated

   ROLES
     viewer     read decisions, mandates, agents, payments, audit
     compliance viewer + generate and review reports
     admin      compliance + create/revoke mandates, manage users

   RATE LIMITS  (fixed window, in-process)
     agent   authorize/pay   120/min per agent
     human   login           10/min per IP     ← credential stuffing
     human   session         600/min per user
```

## 4. Concepts I need first

**Authentication is not authorization.** Who you are, versus what you may do.
The admin key conflated them: holding it meant being everything. Sessions
separate them — identity from the cookie, permission from the role.

**Password hashing is not password encryption.** We must never be able to
recover a password, so we store an **argon2id** hash: deliberately slow and
memory-hard, so an attacker with the database cannot brute-force it cheaply.
This is the opposite of the agent-credential decision, and for a precise reason:
the client sends the secret and we compare hashes (password), versus we must
recompute a MAC and therefore need the key (HMAC). ADR-0015 already argued this.

**Session tokens are bearer credentials, so store a hash of them too.** Anyone
holding the cookie *is* the user. A database dump must not hand an attacker live
sessions, so the cookie holds the token and the table holds its SHA-256.

**Fixed-window vs sliding-window vs token bucket.** Fixed window is trivial and
allows a 2× burst at a window boundary. That is acceptable for an MVP whose
limits exist to bound abuse, not to shape traffic — and stating the weakness is
part of choosing it.

**In-process limiting does not survive horizontal scaling.** Two API instances
mean two counters and twice the limit. Correct at one instance; a shared store
is the fix, and it is recorded rather than pretended away.

**Defence in depth means independent failure.** The mandate mutation endpoints
will require a session *and* a role. The audit tables will still be append-only
at the grant level *and* trigger level. Layers matter only when they fail for
different reasons.

## 5. Design choices & tradeoffs

**1 — Sessions, not JWTs.**
A session can be revoked *now*. A JWT is valid until it expires, which for a
system with a "revoke this operator immediately" requirement is the wrong
default. The cost is a database read per request; at this scale that is a
primary-key lookup.

**2 — `argon2id` via Node's built-in `crypto.scrypt`… no: argon2 is not in Node.**
Node ships **scrypt**, which is memory-hard and entirely respectable, and adding
a native argon2 dependency for an MVP buys little. We use `scrypt` with explicit
parameters and record that argon2id is the preferred production choice.

**3 — The shared admin key stays, but only as a fallback for automation.**
Removing it entirely would break the demo scripts and the seed tooling. It is
demoted: it grants the `admin` role, it is logged loudly on use, and it is
recorded in the threat model as an accepted weakness rather than quietly kept.

**4 — Rate limits are per identity, not per IP, wherever an identity exists.**
An IP is a poor identity: agents behind one NAT would share a budget, and an
attacker with a /64 of IPv6 has effectively unlimited ones. Login is the
exception, because there is no identity yet.

**5 — ESLint arrives now rather than in Phase 1.**
ADR-0004 deferred it deliberately. Adding a linter to 15,000 lines produces a
thousand-line diff nobody reviews. The rules chosen are the ones that would have
caught real bugs from this project's own history — floating promises, unchecked
`any`, unused vars — not stylistic preferences.

**6 — CI runs typecheck, lint and the full suite; it does not deploy.**
A green build should mean "this would work", not "this is now live".

### Where the LLM is, in this phase

Nowhere.

## 6. Files created/modified

```
apps/api/src/
  auth/password.ts          scrypt hashing, constant-time verification
  auth/session.ts           token minting, hashing, expiry
  middleware/session-auth.ts requireRole()
  middleware/rate-limit.ts  fixed-window limiter
  repositories/user-account.ts
  routes/auth.ts            login, logout, whoami
  db/migrations/0011_operators.sql
docs/THREAT_MODEL.md
docs/SECURITY.md
.github/workflows/ci.yml
eslint.config.js
```

## 7. How we test it

| Claim | The test that would fail |
|---|---|
| A wrong password is refused | login with a bad password → 401 |
| Password hashes are not reversible | assert the stored value is not the password |
| Timing does not leak whether a user exists | both paths do the same work |
| A session can be revoked immediately | logout, then reuse the cookie → 401 |
| An expired session is refused | set `expires_at` in the past |
| A viewer cannot mutate a mandate | viewer session → 403 |
| A viewer cannot review a report | viewer session → 403 |
| Reads require a session | no cookie → 401 |
| The rate limiter actually limits | N+1 requests → 429 |
| The limiter is per identity | agent A's limit does not affect agent B |
| Session tokens are stored hashed | assert the raw token is absent from the table |

## 8. Security notes

The full STRIDE table lives in `docs/THREAT_MODEL.md`. The properties that must
survive this phase unchanged:

- The LLM still has no payment authority.
- The audit trail is still append-only at two independent layers.
- The voucher is still single-use by database constraint.
- Every claim ceiling stays where it is: **tamper-evident**, **simulated rail**,
  **not a compliance certification**, **cannot file an STR**.

## 9. What happens at scale

Sessions become a shared store or short-lived signed tokens with a revocation
list. Rate limiting moves to Redis or the edge. CI grows a migration check
against a fresh database. None of that changes an interface.

---

## 10. What I learned

**A report that names its own gaps is a report that gets them fixed.** Coverage
went from 20/26 to 22/26 this phase, and the reason is embarrassingly direct:
ATL-C22 and ATL-C23 were printed on a screen a judge would look at, so they got
built. Nothing about the code made them urgent — the *visibility* did. That is
the strongest argument I have found for measuring what is missing rather than
what exists.

**Three credential-storage decisions, one question.** Passwords, HMAC keys and
public keys are stored three different ways, and it looks inconsistent until you
ask *what the verifier needs*:

| | Verifier needs | So we store |
|---|---|---|
| password | to compare a presented secret | a **slow hash** (scrypt) |
| voucher / webhook | to recompute a MAC | **the key** |
| agent signature | to verify a signature | **the public half only** |
| session token | to compare a presented bearer token | a **fast hash** (SHA-256) |

The session row is the interesting one: a plain SHA-256 is *right* there,
because the token already has 256 bits of entropy — there is nothing to
brute-force, and paying scrypt on every single request would be a real cost for
no benefit.

**Sessions, not JWTs, because "revoke now" is a requirement.** A JWT is valid
until it expires whatever you decide in the meantime. For a system whose
security story includes "disable this operator immediately", expiry-only
invalidation is the wrong default. The cost is a primary-key lookup per request.

**Authenticate, then rate-limit — the order is a security property.** Limiting
before authentication means counting against a key id an *unauthenticated*
caller chose, so an attacker could exhaust another agent's budget by sending
garbage with their key id in it. The limiter would become a denial-of-service
tool.

**Timing is a side channel in login, not just in comparison.** I knew about
`timingSafeEqual`. I had not thought about the fact that "no such user"
returning *instantly* while "wrong password" takes 200 ms is a user-enumeration
oracle built out of a stopwatch. The fix — hashing against a dummy value on the
no-user path — is three lines and would never have occurred to me without asking
"what does an attacker learn from each branch?"

**A schema constraint refused my test, and it was right.** I tried to test
session expiry by back-dating `expires_at`, and
`operator_sessions_expiry_after_creation` rejected it. A session that expires
before it was created is not a state that should exist, so it should not be
manufacturable *even by a test*. Testing it with the clock instead is also
closer to what actually happens.

**Choosing a linter is a dependency-compatibility problem, not a taste problem.**
`typescript-eslint` hard-refuses TypeScript 7 — an explicit throw on import, not
a peer warning. Swapping to oxlint costs the type-aware rules, and
`no-floating-promises` is the one I most wanted. Recorded in ADR-0025 with a
"revisit when" rather than pretended away.

## 11. Mistakes made & why

**1. `npm uninstall` pruned a dependency I needed and the whole suite stopped
booting.** Removing ESLint took `vite` with it — a transitive dependency of
vitest — and every test failed with `Cannot find package 'vite'`. The tests had
been green ten minutes earlier. **A green run before a dependency change is not
evidence about after it**, and I would not have noticed for a while if I had not
re-run the suite immediately.

**2. My rate-limiter test asserted the wrong burst shape, and the test caught
me.** I documented "fixed window allows a 2× burst at a wall-clock boundary" and
wrote a test to match. It failed — because my windows are anchored at the *first
request*, not at a wall-clock boundary. The burst is real but has a different
shape. I had documented behaviour I had not measured, and only the test knew.
Both the comment and the test now describe what the code actually does.

**3. I let the rate limiter break my own test suite.** `auth.test.ts` signs in
dozens of times; the real 10/min limit meant tests passed or failed depending on
*order*. The fix was to inject the limit like every other dependency — clock,
providers, payment rail — with the production value as the default so forgetting
it is safe. It took a failing test to notice that a security control I had just
added was making the suite non-deterministic.

**4. I nearly shipped RBAC on the API while the console still used a shared
key.** The API was fixed, the tests passed, and ATL-C22 would have moved to
"covered" — while every actual human using the console was still an anonymous
shared-key holder. Closing a gap in the layer you happen to be editing, and
calling the gap closed, is exactly the kind of composition failure Phase 8
taught me to look for.

## 12. Open questions / debt

- **No type-aware linting.** `no-floating-promises`, `await-thenable` and
  `no-misused-promises` are unavailable until typescript-eslint supports
  TypeScript 7 (their issue #10940). This is the largest single loss in the
  phase.
- **CI has never run.** The workflow is committed and correct as far as I can
  reason about it, but "CI covers this" is a design claim until it goes green on
  GitHub Actions.
- **`docker-compose.yml` has still never been run.** Docker is not installed.
  Now stated plainly in the file rather than implied (ADR-0024).
- **Rate limiting is in-process.** Two API instances mean twice the limit.
  Stated in the control's own `limitation` field, so it appears in the coverage
  report rather than only in a comment.
- **Reading evidence is not audited.** Report *generation* is; report *viewing*
  is not. `CLAUDE.md` §12 lists data access as an event worth capturing, and
  for a system whose product is evidence this is a real gap.
- **The shared admin key still grants admin.** Demoted, logged loudly, surfaced
  in the console as `verifiedIdentity: false` — but it is a standing accepted
  risk, listed as such in the threat model.
- **No password rotation, no MFA, no invite flow.** The seeded operators are
  fixtures. A real deployment needs all three.
- **Sessions are not sliding.** Eight hours from issue, then re-authenticate,
  regardless of activity.
- **The four remaining coverage gaps** — consent withdrawal, external anchoring,
  independent fraud detection, and merchant validation — are all genuinely out
  of scope for an MVP, and three of them need something other than code.
