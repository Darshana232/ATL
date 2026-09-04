# Validation at the boundary

**In one line.** Everything crossing into your system from outside is untrusted
until parsed — and "outside" includes third-party APIs, not just users.

**Analogy.** Airport security is at the perimeter, not at every shop inside the
terminal. Once you're through, everyone can assume you were checked.

**Parse, don't validate.** The important distinction:

```ts
// validate: check it, then carry on with the same unknown type
if (isValid(input)) { use(input as Terms) }   // the cast is a lie

// parse: check it and get back a NEW, TYPED value
const terms = termsSchema.parse(input)        // TypeScript now knows the shape
```

After parsing, the type system carries the guarantee for you. That's why we use
Zod: it produces a type, not just a boolean.

**Three rules we follow.**
1. **Reject unknown fields** (`z.strictObject`). A typo'd field name should be
   an error, not a silently ignored setting.
2. **Report every problem at once.** One round trip should tell a caller
   everything to fix. Same reasoning as the config loader.
3. **Parse third-party responses too.** The Razorpay IFSC API response is
   untrusted input exactly like a request body. If they rename a field, we want
   a clear failure — not `undefined` flowing into our database.

**The 30-second answer.**
> I parse rather than validate: Zod turns unknown input into a typed value, so
> the guarantee is carried by the type system instead of by my memory. It
> happens once, at the boundary. And I apply the same rule to responses from
> external APIs — a third party renaming a field should produce a loud failure
> at the edge, not `undefined` propagating into my database three layers in.

**In our code.** [dto/mandate.ts](../../../apps/api/src/dto/mandate.ts);
[providers/bank-lookup.ts](../../../apps/api/src/providers/bank-lookup.ts)
(`razorpayIfscResponseSchema`);
[config.ts](../../../apps/api/src/config.ts) (the environment is a boundary
too).

**Watch out for.** Validating in the handler *and* the service *and* the
repository. Three copies of a rule is three chances for them to disagree.
