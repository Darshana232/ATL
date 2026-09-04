# What an API actually is

**In one line.** A contract: a fixed set of requests a program will accept, and
what it promises to send back — so two programs written by different people can
work together without either reading the other's code.

**Analogy.** A restaurant menu. You don't go into the kitchen; you order item
14. The kitchen can change its cooker, its chef, its entire layout — as long as
item 14 still arrives, you never notice.

**Why it matters here.** In this project the API *is* the product. The dashboard
is a client. The agent runtime is a client. A payment aggregator integrating us
would be a client. Every one of them talks to the same contract, and the
security boundary is exactly that contract: the agent cannot do anything the API
doesn't offer.

**The 30-second answer.**
> An API is the published contract of a service — the requests it accepts and
> the responses it guarantees. The point is decoupling: as long as the contract
> holds, either side can be rewritten. In my project the API is the trust
> boundary, because what the agent can do is precisely the set of endpoints it
> is allowed to call.

**In our code.** [apps/api/src/server.ts](../../../apps/api/src/server.ts)
builds the server and registers routes;
[routes/health.ts](../../../apps/api/src/routes/health.ts) is the simplest one.

**Watch out for.** "The API" is not "the database with HTTP in front". If your
endpoints are just `SELECT * FROM table`, you have exposed your schema, and now
you can never change it.
