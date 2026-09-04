# Phase 6 — The Audit Chain

**Status:** ⬜ planned · the writer and canonical serialiser already exist
(Phase 3); this phase completes and *proves* the chain

---

## What it is

Turning the audit table into **evidence**: full event coverage, a verification
endpoint that walks the chain and recomputes every hash, and a live
demonstration that tampering is detected.

## Why it comes here

There must be decisions to prove before proving them means anything.

## How a hash chain works

Each row stores the hash of the previous row. Change any old row and every hash
after it stops matching.

```
row 1   hash = H(∅  ‖ record₁)
row 2   hash = H(h₁ ‖ record₂)
row 3   hash = H(h₂ ‖ record₃)     ← edit record₁ and h₂ AND h₃ both break
```

> **Analogy.** A chain of wax seals where each seal is pressed over the previous
> one. Break one and you have to re-seal everything after it — and you'd need
> the stamp.

## The steps

1. **Emit events everywhere** — mandate lifecycle, authorization requests,
   decisions, rule evaluations, voucher mint and redemption, payment attempts
   and outcomes.
2. **`GET /v1/audit/verify`** — walk the chain from genesis, recompute each hash
   from the stored fields, report the first row where it diverges.
3. **The tamper demo** — connect as the *owner* role (the app role literally
   cannot do this), `UPDATE` one historical row, re-run `/verify`, and show it
   naming the exact broken row.
4. **Signed checkpoints** — periodically sign the current head, so the chain
   can't be silently rewritten *wholesale* by someone who can recompute every
   hash.
5. **A test that fails if the hashing scheme changes** — because a silent
   scheme change would invalidate every prior row.

## What you can do after it

The best 90 seconds of the demo: edit the database directly, then run one
command that says *"chain broken at sequence 412"*.

## Concepts it teaches

- [Hash chains and tamper evidence](../concepts/security/07_hash-chains-and-tamper-evidence.md)
- [Canonical JSON](../concepts/security/08_canonical-json.md)
- [Hashing vs encryption](../concepts/security/02_hashing-vs-encryption.md)
- [Append-only tables](../concepts/database/07_append-only-tables-and-triggers.md)

## The honest gap — say this every time

**Tamper-evident, not tamper-proof.** A hash chain *detects* modification. It
does not prevent someone with database superuser rights from rewriting the whole
chain and recomputing every hash. Signed checkpoints published somewhere the
attacker doesn't control raise the bar. They do not eliminate it.
