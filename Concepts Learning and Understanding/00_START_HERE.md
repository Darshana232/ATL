# Concepts, Learning and Understanding

This folder is the **English version of the project**. No code required.

If `docs/` tells you *how it works*, and `Understanding/` tells you *why we
built it that way* in engineering depth, this folder tells you **the whole
idea** — at the level a second-year CS student can read in an evening and then
explain out loud to an interviewer without notes.

Everything here is written to one standard:

> If someone asks you about it in an interview, could you answer in
> **60 seconds**, in your own words, with one concrete example from this
> codebase?

---

## The four things in here

| Folder / file | What it gives you |
|---|---|
| **[01_THE_IDEA.md](01_THE_IDEA.md)** | The product in plain English: what problem, for whom, why now |
| **[02_THE_SYSTEM.md](02_THE_SYSTEM.md)** | The whole architecture as a story, with one worked example |
| **[03_PRODUCT_DECISIONS.md](03_PRODUCT_DECISIONS.md)** | The *product* choices (not the code ones) and the reasoning |
| **[04_INTERVIEW_PACK.md](04_INTERVIEW_PACK.md)** | The 25 questions you will actually be asked, with answers |
| **[concepts/](concepts/)** | ~50 one-page cards: backend, database, security, LLM agents, frontend, engineering, payments domain |
| **[phases/](phases/)** | The 9 build phases — what each one adds, step by step |
| **[codebase/](codebase/)** | A plain-English tour of every file that exists today |

---

## Suggested reading order

**If you have 20 minutes** (you are about to pitch or demo):
`01_THE_IDEA.md` → `02_THE_SYSTEM.md` → `04_INTERVIEW_PACK.md`.

**If you have an evening** (you want to actually understand it):
add `phases/README.md`, then `codebase/README.md`, then browse
`concepts/` for anything that felt hand-wavy.

**If you are revising for an interview:**
`04_INTERVIEW_PACK.md`, then the specific concept cards it links to.

---

## How to read a concept card

Every card in `concepts/` has the same six parts, deliberately:

```
In one line          the definition you would give first
Analogy              a real-world thing it behaves like
Why it matters here  where this project would break without it
The 30-second answer what you say in an interview
In our code          the actual file, so it is not abstract
Watch out for        the mistake people make, so you sound experienced
```

You do not need to read them in order. They are cards, not chapters. Skim the
index, pick the ones you want to be able to defend, and ignore the rest until
you need them.

---

## Honesty rules that apply to this folder too

This project has a strict rule about not overclaiming, and these documents
follow it:

- The audit trail is **tamper-evident**, never *tamper-proof*.
- Anything simulated is **labelled SIMULATED** — the UPI mandate rail, the
  risk provider, the product catalog.
- No claim of RBI approval, NPCI certification or FIU-IND integration exists,
  because none of those things exist.
- Where this folder says "we will", it means *not built yet*. Where it says
  "we do", the code is in the repo. `phases/README.md` is the source of truth
  for which is which.

If you catch a document here claiming something the code does not do, that is
a bug in the document. Fix it.
