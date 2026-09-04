# IDEA #5: REGIONAL AGENTIC COMMERCE STACK (RACS)
## ASEAN/LATAM/Africa Expansion Strategy

**Status:** Investable Pitch-Ready | **Priority:** P2 | **Timeline:** MVP in 12-16 weeks

---

## EXECUTIVE SUMMARY

**What:** Port Razorpay's agentic commerce stack (Agentic Payments Platform) to regional payment systems in Southeast Asia (Grab, GCash), Latin America (Mercado Pago, Nubank), and Africa (emerging stacks).

**Why:**
- **Razorpay owns the playbook** (India: NPCI + UPI Reserve Pay)
- **Southeast Asia has 600M+ people**, zero agentic commerce standard
- **LATAM has $400B+ e-commerce**, fragmented payment rails
- **Africa has $200B+ e-commerce**, USSD-native opportunity
- **No competitor offering regional agentic commerce** (greenfield across regions)

**How:**
- Adapt UPI Reserve Pay logic for Grab, GCash, Mercado Pago
- Localize LLMs (Thai, Vietnamese, Filipino, Spanish, Portuguese)
- Build regional compliance (Thai SEC, Philippine BIR, LATAM regulations)
- Partner with regional payment processors + LLM providers

**Market Impact:**
- **ASEAN TAM:** $100-200B (if 5% adopt agentic in 3 years)
- **LATAM TAM:** $300-500B
- **Africa TAM:** $50-100B
- **Year 1-2 Revenue (ASEAN):** ₹50-100Cr
- **Year 2-3 Revenue (LATAM):** ₹100-200Cr

**Why Now:**
1. Razorpay has India playbook (repeatable)
2. Regional payment processors ready for partnerships
3. LLM localization improving (Claude supports 50+ languages)
4. Regulatory frameworks stabilizing (ASEAN forming guidelines)

---

## MARKET SCENARIO

### Southeast Asia (Priority #1)

**Market Size:**
- Population: 600M+
- Internet users: 450M+
- E-commerce: $200B+ annually (2026)
- Agentic commerce TAM (if 5% adoption): $10B

**Key Players:**
- **Grab:** Ride-sharing + payments + commerce (GrabFood, GrabMart)
- **GCash:** Philippines' dominant fintech (55M+ users)
- **Alipay:** Singapore/Malaysia presence (Ant Financial)
- **OVO:** Indonesia's e-wallet leader
- **Shopee:** Regional marketplace (payment rail)

**Regulatory Status:**
- Thailand: SEC guidelines in progress (2026-2027)
- Philippines: BIR working on AI commerce rules
- Singapore: MAS guidance forthcoming
- Indonesia: OJK frameworks developing

**Opportunity:**
- No agentic commerce standard yet (Razorpay can define it)
- Regional partnership with Grab + GCash = instant distribution
- Localized LLMs for Thai, Filipino, Vietnamese, Indonesian

### Latin America (Priority #2)

**Market Size:**
- Population: 650M+
- E-commerce: $400B+ annually
- Agentic commerce TAM (if 3% adoption by 2028): $12B

**Key Players:**
- **Mercado Pago:** Largest payment processor (Brazil, Mexico, Argentina)
- **Nubank:** Fastest-growing fintech (50M+ users, 5 countries)
- **AWS Payments:** Emerging (backing small processors)

**Opportunity:**
- LATAM has stronger regulatory environments (easier compliance)
- Spanish/Portuguese-speaking agents (LLM localization straightforward)
- Mercado Pago partnership = access to 1M+ merchants

### Africa (Priority #3, 2028+)

**Market Size:**
- Population: 1.4B+
- E-commerce: $200B+ annually (and growing 25% CAGR)
- Agentic commerce TAM (if 2% adoption): $4B

**Key Feature:** USSD-native agentic commerce
- 2G/3G connectivity prevalent (low bandwidth)
- Build agentic ordering via USSD (text-based, no app)
- Example: "Dial *123# → Agent orders groceries via USSD"

**Key Players:**
- **M-Pesa:** Kenya's payment rail
- **Tigo Money:** Tanzania/Africa
- **Local processors:** Country-specific

---

## IMPLEMENTATION STRATEGY

### Phase 1: ASEAN Expansion (Months 1-16)

#### Country 1: Thailand (Grab Partnership)

**Timeline:** Months 1-4

**Scope:**
- Adapt Agentic Payments for Thai Baht (THB)
- Integrate Grab's payment rails (Grab Pay)
- Localize Claude for Thai language
- Build Thai regulatory compliance (SEC)
- Launch with 5 merchants (GrabFood partners)

**Partnership Model:**
- Razorpay + Grab co-market as "Grab Agent Commerce"
- Grab gets 30% of Razorpay fees (revenue share)
- Shared branding + distribution

**Tech Stack:**
- Extend Razorpay Agentic Payments (Python + FastAPI)
- Claude Thai localization (via Anthropic)
- Grab's payment API integration
- Thai compliance rules engine

**Deliverables:**
- Thai-language agent commerce platform
- Grab Pay integration (settled in THB)
- 5-10 live merchants
- Regulatory compliance report (SEC-ready)

#### Country 2: Philippines (GCash Partnership)

**Timeline:** Months 5-8

**Scope:**
- Integrate GCash payment rails (Filipino Peso, PHP)
- Localize Claude for Filipino/Tagalog
- Build BIR compliance (tax authority)
- Launch with 10 merchants (GCash merchants)

**Partnership Model:**
- Razorpay + GCash co-market
- GCash gets 25% revenue share (smaller deal than Grab)
- Combined reach: 55M GCash users

**Deliverables:**
- Filipino-language agent commerce platform
- GCash integration (PHP settlement)
- 10-20 live merchants
- BIR compliance certification

#### Country 3: Vietnam/Indonesia (Alipay/OVO Partnership)

**Timeline:** Months 9-12

**Scope:**
- Vietnam: Alipay partnership (Vietnamese Dong, VND)
- Indonesia: OVO partnership (Indonesian Rupiah, IDR)
- Localize Claude for Vietnamese + Indonesian
- Regulatory compliance (Vietnam Central Bank, Indonesia OJK)

**Deliverables:**
- 50+ merchants across both countries
- Multi-currency support (VND, IDR)
- Regional compliance framework

### Phase 2: LATAM Expansion (Months 13-24)

**Timeline:** Months 13-20

**Countries:** Brazil, Mexico, Argentina

**Strategy:**
- Mercado Pago partnership (primary)
- Nubank partnership (secondary)
- Spanish/Portuguese localization (single LLM fine-tuning)
- Mercado Pago merchant network distribution

**Revenue Potential:** ₹100-200Cr Year 2

### Phase 3: Africa Expansion (Months 25+)

**Timeline:** 2028+

**Countries:** Kenya, Tanzania, Nigeria

**Unique Strategy:** USSD-native agentic commerce
- Agents place orders via USSD (text-based)
- Offline-first architecture (crucial for connectivity gaps)
- M-Pesa integration

**Revenue Potential:** ₹50-100Cr Year 3

---

## LOCALIZATION STRATEGY

### LLM Localization (Claude)

**Current Status (Aug 2026):**
- Claude supports 50+ languages
- Thai, Filipino, Spanish, Portuguese: All supported
- Quality: Good for understanding, excellent for generation

**Razorpay Localization Plan:**

```
1. Product Taxonomy Localization
   ├─ English: [groceries, electronics, clothing, ...]
   ├─ Thai: [อาหารและเครื่องดื่ม, อิเล็กทรอนิกส์, ...]
   ├─ Filipino: [pagkain at inumin, electronics, ...]
   └─ Spanish: [alimentos y bebidas, electrónica, ...]
   
   Claude fine-tuned on regional catalogs

2. Agent Persona Localization
   ├─ India: "Claude (by Razorpay)"
   ├─ Thailand: "Claude (ชาติไทย Razorpay)"
   ├─ Philippines: "Claude (ng Razorpay)"
   ├─ Brazil: "Claude (por Razorpay)"
   └─ Each with regional personality + cultural norms

3. Guardrail Localization
   ├─ Currency: THB, PHP, BRL, MXN, ARS, KES, NGN
   ├─ Spending limits: By regional economy (e.g., ₹500 → 100 THB)
   ├─ Merchant lists: Regional merchants only
   └─ Category restrictions: Region-specific (e.g., alcohol laws vary)

4. Language-Specific Challenges
   ├─ Thai: Tonal language, complex grammar
   │  → Test with 1,000+ Thai merchants before launch
   │
   ├─ Filipino/Tagalog: Mix of Filipino + English (Taglish)
   │  → Claude already handles code-switching well
   │
   ├─ Spanish: Regional variations (Spain vs. LATAM)
   │  → Train on LATAM Spanish (primary market)
   │
   ├─ Portuguese: Brazil vs. Portugal differences
   │  → Train on Brazilian Portuguese (99% of LATAM market)
   │
   └─ African languages: Swahili, Yoruba, Zulu
      → Phase 3, more complex (smaller initial TAM)
```

---

## PARTNERSHIP STRATEGY

### ASEAN: Grab Partnership (Highest Priority)

**Why Grab?**
- 600M+ users across SE Asia
- Ride-sharing → food delivery → marketplace ecosystem
- Payment rail ready (Grab Pay)
- Merchant network: 500K+ merchants

**Deal Structure:**
- Revenue share: Grab gets 30% of Razorpay's take
- Marketing: Co-branded as "Grab Agent Commerce"
- Distribution: Grab promotes to merchant base
- Data: Razorpay can use anonymized Grab data for optimization

**Projected Year 1 (ASEAN via Grab):**
- 100+ merchants live
- ₹30-50Cr revenue (Razorpay's 70% share)

### LATAM: Mercado Pago Partnership

**Why Mercado Pago?**
- Market leader (50%+ market share in major LATAM countries)
- 1M+ merchants
- Payment rails: Native to Brazil, Mexico, Argentina
- Regulatory relationships established

**Deal Structure:**
- Revenue share: Mercado Pago gets 25-30%
- Co-brand: "Mercado Pago + Razorpay Agent Commerce"
- Merchant access: Mercado Pago promotes to network
- Compliance: Mercado Pago handles local regulatory

**Projected Year 1 (LATAM):**
- 50+ merchants live (ramp-up in Year 2)
- ₹20-30Cr revenue

---

## REGIONAL COMPLIANCE FRAMEWORK

### Thailand (SEC)
- Agent registration required (cryptographic verification)
- Spending limits per user (similar to UAP)
- Audit trail mandatory (7-year retention)
- Expected finalization: 2027

### Philippines (BIR)
- Tax reporting on agentic transactions (1099-equivalent)
- Merchant compliance (VAT, withholding)
- Expected guidance: Q4 2026 - Q2 2027

### Indonesia (OJK)
- Payment provider regulations apply
- Agent identity verification
- AML/KYC for agents (Know-Your-Agent)
- Expected: 2027

### LATAM (Regional)
- Brazil (BCB): Pix integration, AI oversight
- Mexico (BANXICO): Digital payment regulations
- Argentina (BCRA): Compliance with peso settlement rules
- All expected: 2027-2028

---

## FINANCIAL MODEL

### ASEAN Revenue (Year 1-3)

| Year | Merchants | Avg Monthly Spend | MRR | Annual |
|------|-----------|---|---|---|
| **Year 1** | 50 | ₹50K | ₹25L | ₹3Cr |
| **Year 2** | 250 | ₹75K | ₹187L | ₹22.5Cr |
| **Year 3** | 500 | ₹100K | ₹50L | ₹60Cr |

**Incremental LATAM (Starting Year 2):**
- Year 2: ₹10-15Cr
- Year 3: ₹40-60Cr

**Total Regional Revenue by Year 3:** ₹100-120Cr+

---

## TECH ARCHITECTURE CHANGES

### Multi-Region Setup

```
Razorpay Agentic Payments (Global):

Core Platform (Same for all regions):
├─ Agent orchestration (LangGraph)
├─ Payment authorization engine
├─ Audit trail (immutable logging)
└─ Dashboard + APIs

Regional Adaptations:
├─ ASEAN (Thailand, Philippines, Vietnam, Indonesia)
│  ├─ Currency: THB, PHP, VND, IDR
│  ├─ LLM: Claude (Thai, Filipino, Vietnamese, Indonesian)
│  ├─ Payment Rails: Grab Pay, GCash, Alipay, OVO
│  ├─ Compliance: Regional frameworks
│  └─ Merchants: GrabFood, GCash partners, etc.
│
├─ LATAM (Brazil, Mexico, Argentina)
│  ├─ Currency: BRL, MXN, ARS
│  ├─ LLM: Claude (Spanish, Portuguese)
│  ├─ Payment Rails: Mercado Pago, Nubank, PIX
│  ├─ Compliance: Brazilian, Mexican, Argentine rules
│  └─ Merchants: Mercado Pago network
│
└─ Africa (Kenya, Tanzania, Nigeria, 2028+)
   ├─ Currency: KES, TZS, NGN
   ├─ LLM: Claude (Swahili, Yoruba, English)
   ├─ Payment Rails: M-Pesa, local processors
   ├─ Offline-first architecture (USSD)
   └─ Merchants: Local e-commerce platforms
```

---

## SUCCESS METRICS

### ASEAN (Year 1)
- 50-100 merchants live
- ₹3Cr annual revenue (Razorpay's share)
- 500K+ agentic transactions per month

### LATAM (Year 2-3)
- 250+ merchants live
- ₹50Cr+ annual revenue
- 2M+ agentic transactions per month

### Global Regional (Year 3)
- 1,000+ merchants across regions
- ₹100Cr+ annual revenue
- "Razorpay is the agentic commerce OS for emerging markets"

---

**Document Version:** 1.0 | **Last Updated:** 2026-08-31

