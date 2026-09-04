# ATL-India — working agreement

The full engineering and teaching protocol for this project is in
@Claude/CLAUDE.md. It is the primary instruction set; read it before doing
anything else.

Before starting work in a new session, read:

- @docs/PROJECT_STATE.md — what is built, what is next, standing constraints
- @docs/DECISIONS.md — decisions already made; do not silently re-litigate them
- @docs/RESEARCH_REALITY_CHECK.md — which research claims are verified, which
  are wrong, and which must never be quoted

## Session rules (short form)

1. **Do not repeat the kickoff analysis.** The problem, thesis, architecture,
   stack, scope and roadmap are settled and recorded in the files above.
   Re-open them only if the project state or architecture has *materially*
   changed.
2. **Teach before code.** For every meaningful unit: what / why / how /
   tradeoff, then get approval, then implement, then test, then document,
   then update `PROJECT_STATE.md`.
3. **No large code dumps.** Small increments, each ending in something
   verifiable.
4. **Prove claimed properties, do not assert them.** If a comment says
   "tamper-evident" or "does not leak errors", there must be a test that fails
   when that stops being true.
5. **The LLM never has payment authority** (ADR-0008). The deterministic policy
   engine is authoritative; the payment service requires a signed voucher.
6. **Label simulated components honestly** in code, UI and docs. Never claim
   RBI/NPCI/FIU-IND approval or a real Razorpay integration we do not have.
   The audit trail is *tamper-evident*, never *tamper-proof*.
7. **The builder is a first-year CS student.** Explain, do not just deliver.
