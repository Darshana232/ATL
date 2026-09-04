# Research Reality Check

The `Research/` folder contains ~15,000 lines of strategy material. Some of it
is accurate, some is unverifiable, and some is wrong. This file records what was
checked on **2026-09-04**, so nobody has to re-verify it every session and
nobody accidentally repeats a false claim in a pitch.

Classification follows `Claude/CLAUDE.md` §2.

---

## VERIFIED — safe to state, with sources

| Claim | Detail |
|---|---|
| **NPCI + Razorpay + OpenAI agentic payments pilot** | Announced Oct 2025. Built on **UPI Reserve Pay + UPI Circle**. Axis Bank and Airtel Payments Bank as banking partners; BigBasket the first merchant. |
| **Razorpay + NPCI agentic payments on Claude** | Feb 2026 pilot, select users, with Zomato, Swiggy and Zepto. |
| **RBI FREE-AI framework** | Committee report released **13 Aug 2025**, chaired by Prof. Pushpak Bhattacharyya (IIT Bombay). **7 sutras** (Trust, People First, Innovation, Fairness, Accountability, Explainability, Resilience), **6 pillars** (Infrastructure, Policy, Capacity, Governance, Protection, Assurance), 26 recommendations. |
| **DPDP Rules 2025** | Notified **13 Nov 2025**, Gazette 14 Nov 2025. |
| **UPI Autopay AFA thresholds** | AFA-exempt limit raised from ₹15,000 to ₹1,00,000 for specific MCCs. NPCI circular **UPI/OC-151A, 14 Dec 2023**. |
| **Razorpay MCP server** | Official, `github.com/razorpay/razorpay-mcp-server`, **MIT**, 50+ tools (payments, orders, payment links incl. UPI, refunds, settlements, payouts, QR, tokens). Remote server at `https://mcp.razorpay.com/mcp`. |
| **Razorpay test mode** | Separate test API keys, test UPI IDs, no real money, usable **without full KYC**. This is our one genuine payment integration. |
| **Razorpay Vulcan** | Real. Payments foundation model launched Aug 2026 with NVIDIA and AWS. **No public API** — we cannot use it. |
| **ACP (Agentic Commerce Protocol)** | OpenAI + Stripe, Apache-2.0, spec released **29 Sept 2025** alongside ChatGPT Instant Checkout. |
| **AP2 (Agent Payments Protocol)** | Google, announced **16 Sept 2025**, 60+ partners, Apache-2.0 at `github.com/google-agentic-commerce/AP2`. Three signed mandates (**Intent, Cart, Payment**) as W3C Verifiable Credentials. v0.2 Apr 2026; donated to the FIDO Alliance. |

**Sources:** razorpay.com/newsroom + razorpay.com/blog; rbi.org.in (FREE-AI
committee report); pib.gov.in (DPDP Rules notification);
npci.org.in circular UPI/OC-151A; github.com/razorpay/razorpay-mcp-server;
github.com/google-agentic-commerce/AP2; openai.com/index/buy-it-in-chatgpt;
techcrunch.com, business-standard.com, medianama.com for pilot reporting.

---

## CORRECTED — the research is wrong or materially misleading

| # | Research says | Reality | What we do |
|---|---|---|---|
| 1 | "NPCI UAP pilot is live with Bigbasket, Vi, Zomato" | Conflates two things. The **pilot** is live on UPI Reserve Pay/Circle. **UAP (Unified Agent Protocol) is still in development** — no published spec, requires RBI approval, reportedly to be unveiled at Global Fintech Fest 2026. | We cannot implement UAP. Our mandate model is our own design, adapter-isolated, labelled `PROPOSED / SIMULATED`. |
| 2 | "DPDP Rules in force Nov 2025" | Notified then, but **phased**: Data Protection Board immediately; Consent Manager registration and penalties **13 Nov 2026**; full notice/consent/security/rights obligations **13 May 2027**. | Never claim merchants are non-compliant *today*. The honest pitch is "obligations land within ~8 months and the missing control is machine-generated evidence." |
| 3 | `CONSTRAINT no_updates CHECK (true)` / `CHECK (false)` for immutability | Broken SQL. `CHECK (true)` does nothing; `CHECK (false)` blocks inserts too. Appears in three documents. | Real immutability: `REVOKE UPDATE, DELETE` from the app role **plus** a `BEFORE UPDATE OR DELETE` trigger that raises. |
| 4 | "98.75% COMPLIANT with RBI FREE-AI", "DPDP score 100%" | Indefensible. FREE-AI is a committee framework of recommendations; there is no certifying authority and no scoring methodology. | Report **Control Coverage: n/20** with per-control evidence and named gaps. Matches `Claude/CLAUDE.md` §13, which overrides the research. |
| 5 | "₹15,000 default mandate cap" | That is the **AFA (UPI-PIN) exemption threshold**, not a mandate spending cap. | Model as two distinct rules: `MANDATE_PER_TXN_LIMIT` (user-set) and `AFA_EXEMPTION_THRESHOLD` (regulatory, informational). Sharper than the research. |
| 6 | "Auto-file STR with FIU-IND" | FIU-IND filing runs through FINnet by registered reporting entities. We have neither access nor authorisation. | Generate a **DRAFT** with FIU-IND-style fields → human review → "ready for filing". Never "filed". |
| 7 | "AFRI provides risk scores" | **AFRI does not exist.** It is a proposal document in the same research folder — no code, no endpoint. | `RiskProvider` interface + `MockRiskProvider`, labelled. See ADR-0010. |
| 8 | "Consume Razorpay Kafka topic `razorpay.upi.reserve_pay.transactions`"; internal RDS/Elasticsearch; merchant staging credentials | Internal infrastructure with zero external access. The research lists these as Week 1 blockers. | Removed. Ingestion is our own API plus seeded fixtures. No Kafka in the MVP. |
| 9 | "ACP announced October 2024" | Unsupported. The standard's release is **29 Sept 2025**. | Use the correct date. |
| 10 | "₹1.5Cr per merchant per year"; "3 pilot merchants already asking for this"; named quotes from a "Bigbasket Compliance Lead" and a "Payment Processor Compliance Officer" | **These quotes appear to be fabricated for the pitch.** No merchant interviews have taken place. | Never present as validation. Criterion B1 (merchant validation) is currently **MISSING** and must be earned honestly or explicitly scoped as an untested hypothesis. |

---

## UNVERIFIED — do not build on, do not quote

- Market sizing: "$7.7B 2026 market", "$1.5T by 2030", "$65.5B by 2033"
  (internally inconsistent within one table), "50M ChatGPT shopping queries/day",
  "+42% AI shopper conversion lift", "805% YoY Adobe traffic".
- x402 metrics: "165M transactions", "$50M settled", "69,000 active agents".
- "FinCEN PPSI Rule Apr 2026" — could not verify it exists.
- "US FS AI RMF Feb 2026" penalty estimates.
- EU AI Act penalty tiers as applied to agentic payments — also out of scope for
  an India-first MVP.
- Vulcan internals: "3 trillion data points", "3,000 signals per transaction",
  "20 TB/day", "+8–10% success rate". Vendor-stated; cite as vendor claims only.

**Rule:** none of these numbers appear in our product, our reports, or our
metrics. Criterion A4 metrics must be measured from our own running system.

---

## Scope reminder from `Claude/CLAUDE.md` §33

Never claim RBI approval, NPCI certification, FIU-IND integration or production
Razorpay infrastructure. Acceptable framing: "Razorpay-inspired architecture",
"sandbox integration", "MVP simulation", "demonstration implementation".

Our claim ceiling on the audit trail is **tamper-evident**, not tamper-proof: a
hash chain *detects* modification; it does not prevent someone with database
superuser rights from rewriting the entire chain. Signed checkpoints raise that
bar; they do not eliminate it.
