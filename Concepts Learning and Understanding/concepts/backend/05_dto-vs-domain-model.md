# DTO vs domain model

**In one line.** The shape you send over the network is deliberately *not* the
shape you compute with.

**Analogy.** A postcard versus a memory. The postcard is flattened, standardised
and safe to hand to a stranger. Your memory of the holiday is richer and
structured differently. You don't mail your memory.

**The two shapes here.**

```
wire (DTO)   { "perTxnLimitPaise": 200000, "validFrom": "2026-09-01T00:00:00Z" }
domain       { perTxnLimitPaise: 200000 as Paise, validFrom: Date }
```

**Why bother?** Three reasons:
1. An API change doesn't ripple into business logic.
2. Untrusted input **cannot reach the domain without passing validation**.
3. The domain can use richer types — branded `Paise`, real `Date` objects — that
   have no JSON representation.

**The division of labour** (this is the part that impresses people):

| Layer | Owns | Example |
|---|---|---|
| **Zod** | shape and format — per-field | is it an integer? a valid ISO-8601 instant? does the id match `^mnd_`? |
| **Domain** | meaning — cross-field and semantic | is perTxnLimit ≤ windowLimit? is `"Asia/Kolkata"` a real timezone? duplicates in the array? |

Each rule lives in exactly **one** place. Zod deliberately does *not* re-check
what the domain checks, because two copies of a rule drift apart.

**The 30-second answer.**
> The wire shape isn't the domain shape. I parse the wire shape with Zod, which
> owns format, and map it into domain objects, which own meaning. Keeping them
> separate means untrusted input can't reach business logic unvalidated, and an
> API change doesn't ripple inward. The subtlety is dividing responsibility so
> the same rule isn't written twice — Zod checks "is this an integer", the
> domain checks "is this limit smaller than that one".

**In our code.** [dto/mandate.ts](../../../apps/api/src/dto/mandate.ts) —
`termsSchema`, `termsToDomain()`, `mandateToWire()`.

**Watch out for.** Returning your database rows directly as JSON. Now your
column names are a public API and you can never rename one.
