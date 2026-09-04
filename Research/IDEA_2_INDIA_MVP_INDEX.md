# IDEA #2 India MVP: Complete Deliverable Index

## What You're Getting (4 New + 1 Reference)

### 📋 Documents Created for This MVP

| Document | Size | Purpose | Read Time | How to Use |
|---|---|---|---|---|
| **IDEA_2_INDIA_MVP.md** | 41KB | Complete technical specification | 30-40 min | Full read for builders; Section 1 + 3 for quick brief |
| **IDEA_2_INDIA_MVP_SUMMARY.md** | 9.4KB | Executive summary + pitch rationale | 10 min | Hand to investors/judges; clear differentiation from ATCE |
| **IDEA_2_INDIA_MVP_QUICKSTART.md** | 8KB | Quick-start guide + FAQ + checklists | 15 min | Read this first; then dive into full spec |
| **IDEA_2_INDIA_MVP_INDEX.md** | This file | Navigation guide | 5 min | You're reading it now |

### 📚 Reference Documents

| Document | Purpose | Notes |
|---|---|---|
| **IDEA_2_AGENT_TRUST_COMPLIANCE_ENGINE.md** (32KB, Original) | Original global ATCE pitch | India MVP is a reground of this; reference only if asked "what about global ATCE?" |
| **AGENTIC_COMMERCE_MARKET_RESEARCH_2026.md** | Market research + NPCI UAP pilot details | Source of truth for pilot merchant names, UAP timeline, UPI Autopay mechanics |
| **razorpay-founder-assessment-criteria.md** | Buildathon quality standards | Used to validate India MVP against A1-A8, B1-B6, C1-C6 criteria |
| **INVESTMENT_THESIS_SUMMARY.md** | Original 6-idea portfolio pitch | Context for how ATL-India (IDEA #2) fits alongside AFRI (IDEA #6) |

---

## Reading Paths (Based on Your Role)

### 🎯 **You're a Founder / Investor (5-10 min)**
1. Read: **IDEA_2_INDIA_MVP_QUICKSTART.md** (full, this sets context + positioning)
2. Skim: **IDEA_2_INDIA_MVP_SUMMARY.md** (regulatory grounding + revenue model)
3. Bookmark: **IDEA_2_INDIA_MVP.md** Section 1 + 3 (problem + regulations) for deeper dives

**Outcome:** You can pitch this to anyone in < 2 minutes.

---

### 🛠️ **You're an Engineer (Building This MVP) (45-60 min)**
1. Read: **IDEA_2_INDIA_MVP.md** Sections 4-5 (architecture + features)
2. Reference: **IDEA_2_INDIA_MVP.md** Section 8 (8-week roadmap + Week 1-2 checklist)
3. Bookmark: **IDEA_2_INDIA_MVP_QUICKSTART.md** Section "Build Checklist" (weekly milestones)
4. Understand: **IDEA_2_INDIA_MVP.md** Section 3 (regulatory accuracy + what's verified vs. needs re-checking)

**Outcome:** You know exactly what to build and in what order. You have sample JSON schema, database design, reports structure.

---

### 📊 **You're a Compliance / Legal Officer (20-30 min)**
1. Read: **IDEA_2_INDIA_MVP.md** Section 3 (regulatory grounding, all 4 frameworks)
2. Read: **IDEA_2_INDIA_MVP.md** Section 5 (Features 2c, DPDP data register + Feature 3, rules logic)
3. Reference: **IDEA_2_INDIA_MVP.md** Risk & Mitigation section (Risk 4: Data Privacy / DPDP Enforcement)
4. Bookmark: Regulatory Accuracy Note at end (facts verified vs. facts needing spot-check)

**Outcome:** You know the compliance assumptions, the DPDP implementation, and what needs pre-pitch verification.

---

### 🎤 **You're Pitching This (30-45 min)**
1. Memorize: **IDEA_2_INDIA_MVP_QUICKSTART.md** "30-Second Pitch" + "2-Minute Pitch"
2. Read: **IDEA_2_INDIA_MVP_SUMMARY.md** (investor-friendly overview)
3. Reference: **IDEA_2_INDIA_MVP.md** Section 9 (success metrics, financial model, competitive position)
4. Answer: **IDEA_2_INDIA_MVP_QUICKSTART.md** FAQ section (if challenged)

**Outcome:** You can present this confidently to investors, judges, or your leadership. You have rebuttals for common objections.

---

### 🤝 **You're Onboarding a Merchant or Processor (10-15 min)**
1. Read: **IDEA_2_INDIA_MVP.md** Section 2 (the real gap, merchant validation)
2. Show: **IDEA_2_INDIA_MVP.md** Section 5, Feature 2 (compliance reports they'll receive)
3. Show: **IDEA_2_INDIA_MVP.md** Section 5, Feature 4 (certification badge they can use)
4. Reference: **IDEA_2_INDIA_MVP.md** Section 9 (revenue model for their segment)

**Outcome:** Merchant understands what they're getting, why it matters, and what Razorpay will charge.

---

## Core Concepts (One-Liners to Memorize)

| Concept | Explanation |
|---|---|
| **FREE-AI Framework** | RBI's 6 pillars + 7 sutras for responsible AI in finance (published Aug 2025). No processor has built tooling to operationalize it for agents yet. This MVP is that tooling. |
| **DPDP Rules 2025** | India's binding data-protection law (in force Nov 2025). Governs personal data an audit trail stores (intent, phone, VPA). Non-compliance = Data Protection Board enforcement. |
| **NPCI UAP** | NPCI's Unified Agent Protocol, in pilot (Oct 2025–Dec 2026) with Bigbasket, Vi, Zomato. Built on existing UPI Reserve Pay mandate rail. Razorpay is the only PA inside this pilot. |
| **Mandate Breach Detection** | 5-7 simple rules (spending cap, merchant allowlist, category blacklist, time window, expiry, velocity, category-adjacent). Explainable, rule-based, NOT ML. |
| **STR (Suspicious Transaction Report)** | PMLA/FIU-IND filing requirement when agent spends past mandate cap or buys blacklisted category. Manual filing takes 45 min; this MVP automates it to 2 min. |
| **Differentiation from AFRI** | AFRI detects fraud (ML, risk scores). ATL-India audits compliance (rules, audit trails). Complementary, not competing. |

---

## Regulatory Facts: What's Solid vs. What Needs Spot-Check

### ✅ **Pre-2025 Knowledge (Safe to Cite Without Re-Verification)**
- UPI Autopay caps: ₹15,000 (default), ₹1,00,000 (premium MCCs per RBI circular RBI/2023-24/88, Dec 2023)
- PMLA/FIU-IND STR obligations (in force since 2002, amended 2023)
- RBI Master Directions on KYC and PA/PG licensing
- DPDP Act 2023 core concepts (passed Aug 2023, not yet in force then)
- Card tokenization (CoFT, effective Oct 1, 2022)

### ⚠️ **Post-Feb-2025 Knowledge (Verify Before Live Pitch)**
- **RBI FREE-AI Framework:** Published Aug 13, 2025 → verify at rbidocs.rbi.org.in
- **DPDP Rules 2025:** Notified Nov 14, 2025 → verify at pib.gov.in
- **FY25 Bank Fraud Stats:** ₹36,014 crore (23,953 cases), ₹981 crore UPI → verify at rbi.org.in
- **NPCI UAP Pilot Details:** Merchants (Bigbasket, Vi, Zomato), timeline (Oct 2025–Dec 2026) → sourced from AGENTIC_COMMERCE_MARKET_RESEARCH_2026.md; verify if challenged

**Spend 10 minutes before a live pitch checking the ⚠️ facts against primary sources.**

---

## Timeline to Presentation-Ready

| Milestone | Time | What's Done |
|---|---|---|
| **Now** | 0 min | You're reading this. All 4 new documents exist. |
| **Understanding** | 15 min | Read QUICKSTART.md end-to-end. You grasp the MVP. |
| **Pitch-Ready** | 30 min | Memorize 30-sec + 2-min pitches. You can explain this to anyone. |
| **Build-Ready** | 1 hour | Engineers read full IDEA_2_INDIA_MVP.md Sections 4-8. You can start Week 1 checklist. |
| **Investor-Ready** | 2 hours | Founders/investors read SUMMARY.md + Section 1 of full spec + FAQ. You're investor-conversation-ready. |

---

## Key Questions Answered by This MVP

| Question | Answered Where |
|---|---|
| **What real problem does this solve?** | IDEA_2_INDIA_MVP.md Section 2 (the real gap) |
| **Why India-first, not global?** | IDEA_2_INDIA_MVP_SUMMARY.md "The Shift" section |
| **How is this different from IDEA_6/AFRI?** | IDEA_2_INDIA_MVP.md Section 6 (differentiation table) |
| **What are the 4 features?** | IDEA_2_INDIA_MVP.md Section 5 (Features 1-4, excruciating detail) |
| **What does the audit trail schema look like?** | IDEA_2_INDIA_MVP.md Section 4 (JSON example) |
| **How do we build this in 6-8 weeks?** | IDEA_2_INDIA_MVP.md Section 8 (roadmap) + QUICKSTART.md (build checklist) |
| **Will merchants actually pay?** | IDEA_2_INDIA_MVP.md Section 9 (financial model) + QUICKSTART.md FAQ |
| **How does this fit into the global ATCE vision?** | IDEA_2_INDIA_MVP_SUMMARY.md "Roadmap: Year 1 → Year 2 → Global" |
| **What regulatory facts need pre-pitch verification?** | IDEA_2_INDIA_MVP.md end (Regulatory Accuracy Note) + QUICKSTART.md (What's Verified) |

---

## Document File Sizes & Word Counts (For Reference)

```
IDEA_2_INDIA_MVP.md              41 KB  (~7,000 words)
IDEA_2_INDIA_MVP_SUMMARY.md       9.4 KB  (~1,500 words)
IDEA_2_INDIA_MVP_QUICKSTART.md    8 KB  (~1,300 words)
IDEA_2_INDIA_MVP_INDEX.md         7 KB  (~1,200 words, this file)
─────────────────────────────────────────────────────
Total                            65.4 KB  (~11,000 words)

For context:
IDEA_2 (Original ATCE)            32 KB  (~5,500 words)
INVESTMENT_THESIS_SUMMARY.md      13.5 KB (~2,300 words)
AGENTIC_COMMERCE_MARKET_RESEARCH  70.6 KB (~12,000 words, full research)
```

---

## Next Steps (After You've Read This Index)

1. **Read QUICKSTART.md** (15 min) → understand positioning + pitch
2. **Send SUMMARY.md to stakeholders** (if getting buy-in) → investor-friendly overview
3. **Engineering team reads full spec Section 4-8** (45 min) → ready to build
4. **Spot-check regulatory facts** (10 min) → verify ⚠️ items before live pitch
5. **Confirm merchant buy-in** (call Bigbasket, Vi, Zomato compliance leads) → validate 3-merchant revenue assumption
6. **Build Week 1** → append-only database + hash-chain + test data

---

## Contact / Support

This MVP was built to:
- ✅ Solve a real, urgent, domestic Indian problem
- ✅ Ground itself in law that's already in force (not pending)
- ✅ Validate against founder criteria (A1-A8, B1-B6, C1-C6)
- ✅ Provide exact technical specs (schema, rules, reports)
- ✅ Give investors confidence (₹5.5-6Cr Year 1 is defensible, not inflated)

If you have questions or find gaps, **check the FAQ in QUICKSTART.md first** — most common objections are answered there.

---

**Last Updated:** September 15, 2026  
**Status:** Ready for Buildathon Submission  
**Next Milestone:** Week 1 Engineering Kickoff
