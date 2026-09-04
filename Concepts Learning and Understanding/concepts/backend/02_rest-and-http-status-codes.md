# REST and HTTP status codes

**In one line.** REST is a style where you name *things* (nouns) with URLs and
act on them with HTTP verbs, and the status code carries the outcome.

**Analogy.** A filing cabinet. `/v1/mandates/mnd_ab12` is a drawer with a label.
`GET` reads it, `POST` adds to it, `DELETE` removes it. You don't have a verb in
the label — you don't call a drawer "getMandateById".

**The verbs you need.**

| Verb | Means | Safe to retry? |
|---|---|---|
| `GET` | read, no side effects | yes |
| `POST` | create / do something | **no** — hence [idempotency keys](11_idempotency.md) |
| `PUT` | replace wholesale | yes (same result each time) |
| `PATCH` | partial update | usually |
| `DELETE` | remove | yes |

**The status codes that matter.**

| Code | Meaning | Our use |
|---|---|---|
| `200` / `201` | fine / created | a mandate was created |
| `400` | *you* sent something malformed | Zod rejected the body |
| `401` | I don't know who you are | missing/wrong admin key |
| `403` | I know who you are, you're not allowed | agent lacks the tool grant |
| `404` | no such thing | unknown mandate id |
| `409` | conflict with current state | revoking an already-revoked mandate |
| `422` | well-formed but semantically wrong | perTxnLimit > windowLimit |
| `429` | too many requests | rate limit (Phase 9) |
| `500` | *I* broke | a bug — never leak details |
| `503` | I'm alive but not ready | database is down |

**The 30-second answer.**
> REST models resources as URLs and uses HTTP verbs and status codes as the
> protocol rather than inventing my own. The distinction I care most about is
> 401 versus 403 — authentication versus authorization — and 400 versus 500,
> because one means the caller made a mistake and the other means I did. In my
> project a validation failure must be a 400 naming the field, not a 500 from a
> database constraint.

**In our code.** [routes/health.ts](../../../apps/api/src/routes/health.ts)
returns 200 or 503; [dto/mandate.ts](../../../apps/api/src/dto/mandate.ts)
shapes 400 bodies.

**Watch out for.** Returning `200 {"error": "..."}`. The status code *is* part
of the contract; clients and load balancers read it.
