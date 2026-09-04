# Layered architecture: route → service → repository

**In one line.** Split code by *responsibility*, so each layer knows only about
the one below it: routes speak HTTP, services hold business rules, repositories
speak SQL.

**Analogy.** A restaurant again — waiter, chef, storeroom. The waiter never goes
into the storeroom. The chef doesn't care whether the order arrived by phone or
in person. Change the phone system and the chef notices nothing.

**The layers here.**

| Layer | Knows about | Never knows about |
|---|---|---|
| **Route** | HTTP, status codes, headers | SQL |
| **DTO** | the wire shape, both directions | the database |
| **Domain** | business rules, invariants | HTTP *and* SQL |
| **Repository** | SQL, table names, indexes | HTTP |

**Why it pays off.** When we change a query or add an index, exactly one file
changes. When the wire format changes, business logic doesn't ripple. And the
domain layer — being ignorant of both ends — can be tested with no server and no
database, which is what makes the Phase 4 policy engine testable at all.

**The 30-second answer.**
> Each layer depends downward only. Routes translate HTTP, the domain holds
> rules, the repository is the only place that knows SQL. The payoff is that the
> business logic has no infrastructure in it, so I can unit-test my policy
> engine with plain values — no database, no clock, no network.

**In our code.**
[domain/mandate.ts](../../../apps/api/src/domain/mandate.ts) is explicitly pure;
[repositories/mandate.ts](../../../apps/api/src/repositories/mandate.ts) is "the
ONLY module that knows SQL for the mandate aggregate";
[dto/mandate.ts](../../../apps/api/src/dto/mandate.ts) is the only module that
knows both shapes.

**Watch out for.** Layers that leak — a repository returning raw rows straight
to the route, or a domain object with a `save()` method on it. Then you have
folders, not layers.
