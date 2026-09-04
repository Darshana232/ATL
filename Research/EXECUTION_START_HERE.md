# 🚀 EXECUTION START HERE: India MVP Build Plan Overview

**Status:** Ready to Start Building | **Timeline:** 8 Weeks | **Team:** 3.5 FTE | **Buildathon Submission:** End of Week 8

---

## What You're About to Build

**A fully functional, production-ready MVP of the Agentic Trust & Compliance Layer (ATL-India) for Razorpay's buildathon.**

This system will:
- ✅ Log every AI agent-authorized UPI payment in an immutable, tamper-proof audit trail
- ✅ Detect mandate breaches with 5-7 explainable rules (cap, allowlist, blacklist, time window, expiry, velocity, category-adjacent)
- ✅ Auto-generate 3 compliance reports (FREE-AI Framework mapping, STR drafts for FIU-IND, DPDP data-processing registers)
- ✅ Issue certification badges to merchants proving RBI FREE-AI Framework + DPDP Rules 2025 compliance
- ✅ Process 1,000s of real transactions from Razorpay's NPCI UAP pilot (Bigbasket, Vi, Zomato)
- ✅ Integrate with IDEA_6 (AFRI) fraud detection as an optional input signal

**Market:** Solves a real, urgent, domestic Indian compliance gap. 3 pilot merchants already asking for this.

**Revenue:** ₹5.5-6Cr Year 1 (3 merchants × ₹1.5Cr + white-label licensing), defensible and realistic.

---

## The Three Documents You Need to Understand

### 1. **IDEA_2_INDIA_MVP.md** (41KB) — THE STRATEGY
Read this to understand:
- Why India-first makes sense (real laws in force, live merchants, clear revenue)
- The 4 MVP features in excruciating detail (audit trail schema, 3 reports, 7 rules)
- Differentiation from IDEA_6 (AFRI) — why these are complementary, not competitive
- Regulatory grounding (FREE-AI Framework, DPDP Rules 2025, PMLA/FIU-IND STR obligations)

**Who should read:** Everyone on the team, especially product managers and engineers designing architecture.

**Time:** 30-40 minutes full; 10 minutes for Section 1 + Section 3 if pressed.

---

### 2. **BUILD_PLAN_MVP_EXECUTION.md** (This is your roadmap)
Read this to understand:
- Week-by-week sprint breakdown (what to build each week, why)
- Tech stack (FastAPI, PostgreSQL, React, Kafka, pytest)
- Detailed implementation tasks (with code examples, schema design, API endpoints)
- Testing strategy (75% unit, 20% integration, 5% E2E; >85% coverage target)
- Deployment checklist (production-ready by Week 8)
- Success criteria gates (Go/No-Go decision points at end of Week 2, 4, 6, 7)

**Who should read:** Engineers (backend, frontend, data, QA), DevOps, tech leads.

**Time:** 1-2 hours full; refer back section-by-section during build.

---

### 3. **IDEA_2_INDIA_MVP_QUICKSTART.md** (8KB) — THE PITCH
Read this if you need to:
- Pitch this MVP in 30 seconds or 2 minutes
- Answer investor/judge objections (FAQ section)
- Understand key concepts (FREE-AI, DPDP, NPCI UAP, mandate-breach rules)
- Get role-specific reading paths (founder, engineer, compliance officer, pitch person)

**Who should read:** Product managers, founders, pitch person for buildathon.

**Time:** 15 minutes full.

---

## The Three Supporting Documents

- **IDEA_2_INDIA_MVP_SUMMARY.md** — Executive overview, regulatory grounding, revenue model, roadmap
- **IDEA_2_INDIA_MVP_INDEX.md** — Master navigation guide, core concepts, regulatory facts (verified vs. needs spot-check)
- **IDEA_2_AGENT_TRUST_COMPLIANCE_ENGINE.md** (Original) — Reference only; India MVP is a reground of this

---

## Quick-Start: Next Actions (This Week)

### Engineering Lead (By Friday)
1. [ ] Read `BUILD_PLAN_MVP_EXECUTION.md` Part 1 (tech stack, repo structure)
2. [ ] Set up GitHub repos:
   - `razorpay-atl-india-backend` (FastAPI)
   - `razorpay-atl-india-frontend` (React)
   - `razorpay-atl-india-data` (test fixtures)
3. [ ] Create Jira/GitHub Projects for sprint tracking (8 weeks, weekly tasks)
4. [ ] Book design/architecture session with backend engineer (align on SQLAlchemy models, Kafka ingestion)

### Backend Engineer (By Friday)
1. [ ] Read `BUILD_PLAN_MVP_EXECUTION.md` Week 1-2 section
2. [ ] Set up FastAPI project skeleton
3. [ ] Design PostgreSQL schema (audit_logs table with immutable constraints)
4. [ ] Start: SQLAlchemy ORM models, database connection, migrations (Alembic)

### Frontend Engineer (By Friday)
1. [ ] Read `IDEA_2_INDIA_MVP.md` Section 5 (4 features)
2. [ ] Set up React TypeScript project with Material-UI
3. [ ] Create component stubs (AuditTrailDashboard, TransactionDetail, ComplianceReportViewer, MandateManager)
4. [ ] Design API client (`services/api.ts`)

### Data Engineer (By Friday)
1. [ ] Read `BUILD_PLAN_MVP_EXECUTION.md` Part 2 (data section)
2. [ ] Set up connection to Razorpay Kafka topic (UPI Reserve Pay transactions)
3. [ ] Write data ingestion service (consume Kafka → parse → validate)
4. [ ] Start: Test data generator (10-20 realistic mandates, 1,000 sample transactions)

### Product Manager (By Friday)
1. [ ] Read `IDEA_2_INDIA_MVP.md` full (understand strategy + regulatory grounding)
2. [ ] Read `QUICKSTART.md` (understand pitch)
3. [ ] Contact Bigbasket, Vi, Zomato compliance leads (validate 3-merchant revenue assumption)
4. [ ] Set up weekly sync with engineering lead (standup Tuesdays 10 AM, sprint planning Fridays 4 PM)

### QA / Compliance (By Friday)
1. [ ] Read `BUILD_PLAN_MVP_EXECUTION.md` Part 3 (testing strategy)
2. [ ] Read `IDEA_2_INDIA_MVP.md` Section 3 (regulatory grounding, DPDP implementation)
3. [ ] Create test plan document (outline 100+ test cases)
4. [ ] Design security audit checklist (PII masking, SQL injection, audit log tampering)

---

## Week-by-Week Milestones (What Success Looks Like)

### Week 2 End
- ✅ Audit trail logging working (transactions in DB)
- ✅ Hash chain verified (no tampering detected)
- ✅ 1,000 sample transactions loaded
- ✅ Query API working, dashboard displaying logs
- ✅ Code review + tests passing

**Go/No-Go Decision:** Proceed to Week 3 compliance rules + reports, or debug logging/hash-chain?

### Week 4 End
- ✅ 5 rules implemented + tested (mandate cap, allowlist, blacklist, time window, expiry)
- ✅ 3 compliance reports auto-generated (FREE-AI, STR, DPDP)
- ✅ 10K test transactions processed end-to-end
- ✅ All reports validated (content, formatting, PDFs render)

**Go/No-Go Decision:** Proceed to Week 5 edge cases + DPDP, or fix report generation?

### Week 6 End
- ✅ 7 rules total (+ 2 optional: velocity, category-adjacent)
- ✅ 100+ test cases, >80% coverage
- ✅ Edge cases handled (partial mandates, expired, concurrent, retries)
- ✅ DPDP compliance: PII masking, consent tracking, breach notification
- ✅ Performance: <100ms audit queries, <500ms reports on 10K+ transactions

**Go/No-Go Decision:** Proceed to Week 7 certification + production, or fix edge cases?

### Week 7 End
- ✅ Certification badge system live
- ✅ Merchant onboarding workflow working
- ✅ Deployed to staging (real payment data ingestion)
- ✅ Comprehensive documentation (architecture, API, database, compliance, deployment)
- ✅ Security audit passed

**Go/No-Go Decision:** Ready for buildathon submission?

### Week 8 End
- ✅ 3 pilot merchants onboarded (Bigbasket, Vi, Zomato)
- ✅ First compliance reports generated for each merchant
- ✅ Monitoring + alerting active (production-ready)
- ✅ Buildathon submission complete:
  - Pitch deck (problem, solution, leverage, go-to-market, ask)
  - Live demo system (pre-loaded with pilot data)
  - Technical deep-dive document
  - Source code + documentation

---

## Critical Dependencies (Resolve ASAP)

| Dependency | Owner | Status | Blocker? |
|---|---|---|---|
| Razorpay Kafka topic (UPI Reserve Pay transactions) | Razorpay Payments | TBD | YES — needed by Week 1 end |
| PostgreSQL managed database (RDS/Cloud SQL) | Razorpay DevOps | TBD | YES — needed by Week 1 end |
| Redis + Elasticsearch clusters | Razorpay DevOps | TBD | Medium — needed by Week 3 |
| Real merchant data (Bigbasket, Vi, Zomato) | Razorpay Product | TBD | Medium — needed by Week 2 end |
| Bigbasket, Vi, Zomato credentials (staging) | Razorpay Partnerships | TBD | Medium — needed by Week 7 end |
| AFRI (IDEA_6) API endpoint (fraud risk scores) | AFRI Team | TBD | Low — can mock until Week 6 |

**Action:** Engineering lead to verify all dependencies this week. Escalate to VP Engineering if blockers.

---

## Budget & Resource Checklist

### Team (3.5 FTE)
- [ ] 1 Backend Engineer (Weeks 1-8, full-time)
- [ ] 1 Data Engineer (Weeks 1-8, full-time)
- [ ] 1 Frontend Engineer (Weeks 1-8, full-time)
- [ ] 1 Product Manager (Weeks 2-8, 0.5 FTE)
- [ ] 1 QA/Security Engineer (Weeks 4-8, 0.5 FTE)
- [ ] 1 DevOps (Weeks 6-8, 0.5 FTE)

### Infrastructure (Estimate)
- [ ] AWS/GCP cloud account (₹5-10L/month for 8 weeks)
- [ ] PostgreSQL RDS (₹1-2L)
- [ ] Kafka cluster (₹2-3L)
- [ ] Redis + Elasticsearch (₹1-2L)
- [ ] CI/CD (GitHub Actions, built-in)
- [ ] Monitoring (Prometheus + Grafana, open-source)

### Total Investment
- **Salaries:** ₹2.2Cr (8 weeks, 3.5 FTE @ ₹35-40L annualized)
- **Infrastructure:** ₹10-15L (AWS, databases, clusters)
- **Tools & Licenses:** ₹5-10L (Jira, monitoring, security scanners)
- **Total:** ₹2.3-2.35Cr for 8-week MVP

**ROI:** If merchant licensing conversations yield 2-3 deals by Month 9, payback in ~4-5 months.

---

## The Pitch (Memorize This)

> "Razorpay is the only licensed Payment Aggregator inside NPCI's UPI Autopay agent pilot with Bigbasket, Vi, Zomato. When RBI/NPCI auditors ask 'show me an audit trail for agent-authorized transactions mapped to the FREE-AI Framework,' no one has a standard answer yet.
>
> We're building that in 8 weeks using RBI's FREE-AI Framework (published Aug 2025) and DPDP Rules (in force Nov 2025). It's immutable audit logs + 3 compliance reports (FREE-AI mapping, STR automation, DPDP data register) + certification badge.
>
> 3 pilot merchants are asking for this. White-label processors want to license it. Year 1 revenue: ₹5.5-6Cr. This is Phase 1 of the global ATCE vision, grounded in real, live, enforceable Indian law."

---

## Common Objections & Answers

**Q: "Isn't this just ATCE narrowed to India?"**
A: "No. ATCE depended partly on pending RBI guidance. India MVP's value is grounded in laws already in force (FREE-AI Aug 2025, DPDP Rules Nov 2025). We're not waiting for pending regulation. After proving this in India, we scale to ASEAN/LATAM."

**Q: "How is this different from IDEA_6 (AFRI)?"**
A: "AFRI detects fraud (ML, risk scores). We audit compliance (rules, audit trails). Different layers. AFRI feeds our audit trails for training; we consume their risk scores as input. Complementary."

**Q: "Will merchants actually pay ₹1.5Cr/year?"**
A: "It's bundled with UPI Reserve Pay offering, not standalone. Regulatory risk (audit gap) is low-probability but high-damage; this is insurance. 3 pilot merchants already asking for this."

**Q: "What if RBI's Q4 2026 agent framework contradicts your design?"**
A: "Rule engine is modular. We swap rules as guidance clarifies. The audit trail schema is stable; only rule verdicts change."

---

## Success = Buildathon Win + Year 1 Revenue

If you ship this MVP on time:
1. **Buildathon judges see:** A working system solving a real, urgent domestic Indian problem, grounded in live regulatory frameworks and live merchant demand. Clear differentiation from IDEA_6. Revenue model defensible.
2. **Investors see:** Phase 1 of a ₹30-50Cr India TAM opportunity (scaling to ₹200Cr+ globally). First-mover advantage in FREE-AI Framework tooling. 3 merchants ready to pay.
3. **Merchants see:** Proof of compliance with RBI + DPDP. Certification badge for their websites. STR automation (45 min → 2 min).
4. **Razorpay sees:** New revenue line (₹5.5-6Cr Year 1), strengthened regulatory relationships (NPCI, RBI), defensible competitive moat.

---

## Your Role

**Pick one:**

1. **Engineering Lead:** Drive technical execution, own sprint planning, unblock dependencies, manage code quality
2. **Backend Engineer:** Build audit trail, rules, reports — this is the core of the system
3. **Frontend Engineer:** Build dashboard, UI, merchant experience — this is what pilots will use
4. **Data Engineer:** Build ingestion pipeline, test fixtures — foundation for everything
5. **Product Manager:** Validate strategy with merchants, manage roadmap, prepare buildathon pitch
6. **QA/Security:** Own testing strategy, security audit, load testing — ensure production-ready

**Assign yourself to one role. Read the relevant section of BUILD_PLAN_MVP_EXECUTION.md. Start building.**

---

## Let's Go

**This is a clean, 8-week sprint to a buildathon-ready MVP that solves a real problem with real revenue potential.**

Everything is planned. Dependencies are identified. Tech stack is chosen. Regulatory grounding is solid. Merchants are waiting.

**Read the docs. Align your team. Start Week 1 Monday. Ship by Week 8 Friday.**

Good luck. Build something great.

---

**Version:** 1.0 | **Date:** September 15, 2026 | **Status:** Engineering Kickoff Approved

**Next Steps:**
1. [ ] Engineering lead reads this document
2. [ ] Engineering lead reads BUILD_PLAN_MVP_EXECUTION.md
3. [ ] Engineering lead schedules kickoff meeting with team (Monday 9 AM)
4. [ ] Team assignments finalized
5. [ ] GitHub repos created
6. [ ] Dependencies verified with Razorpay infrastructure teams
7. [ ] Week 1 sprint planning (Monday 2 PM)
8. [ ] First commit pushed (Monday 5 PM)

**Let's build this.**
