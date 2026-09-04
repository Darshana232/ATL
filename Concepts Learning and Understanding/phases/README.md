# The 9 Phases

The project is built in **nine phases**, plus a Phase 0 prologue that was
repo setup rather than product. Each phase ends in something you can *run and
check* — not a half-finished layer.

**The build order is not arbitrary.** Each phase exists because the next one
needs it:

```
nothing can be authorized          before there is a mandate to authorize against   3 → 4
nothing can be requested safely    before there is an engine to answer the request  4 → 5
nothing can be proven              before there are decisions to prove              5 → 6
nothing should be handed to an LLM before there is something safe to hand it        6 → 7
nothing is worth showing           before it is real                                7 → 8
nothing ships                      before it is hardened                            8 → 9
```

---

## Status board

| Phase | Name | What it delivers | Status |
|---|---|---|---|
| 0 | [Prologue](PHASE_0_prologue.md) | Repo, working agreement, decision log, research reality-check | ✅ done |
| 1 | [Foundation](PHASE_1_foundation.md) | Config, logging, DB pool, migration runner, health endpoints, graceful shutdown | ✅ done |
| 2 | [The Database](PHASE_2_database.md) | The full schema: identity, mandates, authorization, audit — plus a least-privilege role and seed data | ✅ done |
| 3 | [Mandates](PHASE_3_mandates.md) | Domain model, wire schemas, repository, audit writer, mandate API | 🔄 in progress |
| 4 | [The Policy Engine](PHASE_4_policy_engine.md) | 7 deterministic rules → a typed `Decision` with reasons | ⬜ next |
| 5 | [The Authorization API](PHASE_5_authorization_api.md) | Agent auth, request signing, idempotency, replay defence, the voucher | ⬜ |
| 6 | [The Audit Chain](PHASE_6_audit_chain.md) | Full hash chain, `/verify`, and a live tamper demo | ⬜ |
| 7 | [Payments & the Agent](PHASE_7_payments_and_agent.md) | Payment adapters, webhooks, then the Claude agent runtime with scoped tools and a prompt-injection test | ⬜ |
| 8 | [Dashboard & Reports](PHASE_8_dashboard_and_reports.md) | Next.js dashboard, and the compliance reports it renders | ⬜ |
| 9 | [Hardening & Ship](PHASE_9_hardening_and_ship.md) | Threat model, security pass, CI, observability, deploy, demo script | ⬜ |

**Roughly:** phases 1–6 are the **credibility** — the parts an engineer will
interrogate. Phase 7–8 are the **story** — the parts that make a demo land.
Phase 9 is what separates a hackathon project from an engineer's project.

---

## A note on the renumbering

This roadmap was previously **thirteen** phases (0–12). It was consolidated to
nine on **2026-09-05** so the plan matches the hackathon's actual shape.
Nothing was dropped — three pairs were merged:

| Old | New | Why the merge is coherent |
|---|---|---|
| 7 Payments + 8 Agent runtime | **7** | Both are "adapter" work sitting on the *outside* of the trust boundary — one for money, one for the model. Neither is meaningful without the other in a demo. |
| 9 Dashboard + 10 Reports | **8** | The reports *are* screens in the dashboard. Splitting them meant building a UI shell twice. |
| 11 Security + 12 Observability/deploy | **9** | One "make it shippable" pass: threat model, hardening, CI, deploy, demo. |

**Phases 1–6 keep their original numbers**, so every existing reference in
`docs/` and `Understanding/` is still correct. Recorded as **ADR-0014**.

---

## How to read a phase file

Each one has the same sections:

```
What it is            one paragraph, no jargon
Why it comes here     what would be impossible without it
The steps             the actual increments, in order, each one shippable
What you can do after the deliverable you can demonstrate
Concepts it teaches   links into ../concepts/
The honest gap        what it does NOT do
```

The **steps** sections are the answer to "what exactly did you build, and in
what order?" — which is the question that separates someone who built a thing
from someone who watched it get built.
