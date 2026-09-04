# The request lifecycle (and what a framework does)

**In one line.** A web framework turns a raw TCP byte stream into a parsed
request object, runs it through a pipeline of hooks, calls your handler, and
serialises the result back.

**Analogy.** An airport. Check-in (parse), security (auth), gate (routing), the
flight (your handler), baggage claim (serialisation). Each stage can stop you,
and each stage is somebody else's job.

**The pipeline, in our server.**

```
request in
  │  assign a request id            ← so every log line is correlatable
  │  parse body (JSON)              ← rejects malformed input before your code
  │  route match                    ← 404 handler if nothing matches
  │  preHandler hooks               ← auth lives here (requireAdminKey)
  │  YOUR HANDLER                   ← business logic only
  │  serialise the reply
  │  error handler                  ← anything thrown lands here
response out
```

**Why Fastify.** Fast, schema-first (it can validate *and* serialise from a
schema), first-class TypeScript, and hooks are explicit rather than magical
middleware ordering.

**The 30-second answer.**
> A framework gives you a request pipeline. The valuable part isn't routing —
> it's that cross-cutting concerns live in *one* place: request IDs,
> authentication, error handling and 404s are hooks, not something every handler
> remembers to do. In my server, `buildServer()` wires those once, so a route
> file contains only business logic.

**In our code.** [apps/api/src/server.ts](../../../apps/api/src/server.ts) —
`buildServer()` does dependency injection, request IDs, the 404 handler and the
error handler.

**Watch out for.** Putting auth inside handlers. One handler will forget, and
that's the one that gets found.
