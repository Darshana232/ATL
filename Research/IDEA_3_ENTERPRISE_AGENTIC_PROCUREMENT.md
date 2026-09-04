# IDEA #3: ENTERPRISE AGENTIC PROCUREMENT NETWORK (EAPN)
## Multi-Stakeholder Approval Workflows for B2B Agent Commerce

**Status:** Investable Pitch-Ready | **Priority:** P1 | **Timeline:** MVP in 8-10 weeks

---

## EXECUTIVE SUMMARY

**What:** Enterprise SaaS platform that enables multi-stakeholder approval workflows for autonomous procurement—agents place purchase orders that auto-route for approval (budget owner → manager → CFO) and auto-execute when all approve.

**Why:** 
- **Enterprise procurement is $500B-$1T annual market in India alone**
- **Zero agentic solutions exist** (greenfield)
- **Procurement cycle today:** 2-4 weeks (emails, spreadsheets, callbacks)
- **With agents:** 2-4 hours (autonomous, rule-enforced)

**How:**
- Extend Razorpay Agentic Payments to B2B workflows
- Multi-stakeholder approval engine (smart routing)
- Vendor compliance checking (GST, past performance, ratings)
- Contract integration (auto-pull negotiated pricing)
- Spend analytics (cost optimization, delivery time tradeoff)

**Market Impact:**
- **Year 1 Revenue:** ₹50Cr
- **TAM (India):** $1-5T (if 0.1% adopted = ₹50-250Cr annually)
- **Competitive Moat:** First-mover in agentic B2B procurement

**Why Now:**
1. Agentic commerce framework proven (B2C successful)
2. Enterprise procurement is ripe for disruption (manual, slow)
3. Razorpay has payment infrastructure for B2B (corporate cards, etc.)
4. No competitor yet building agentic procurement

---

## PROBLEM STATEMENT

### The Core Problem: Enterprise Procurement is Broken

**Current Process (4 weeks to close a purchase order):**

```
Monday: Procurement manager receives requirement
  ↓
"We need 50 laptops for new office"

Tuesday-Wednesday: Research phase
  ├─ Email vendors for quotes
  ├─ Wait 24-48 hours for responses
  ├─ Compile spreadsheet
  └─ Identify top 3 vendors

Thursday: Budget approval
  ├─ Email Finance VP: "Need budget for ₹75L"
  ├─ Finance VP: "Is this the best deal? Let me ask CFO"
  ├─ Back-and-forth emails
  └─ Approval: ₹75L approved (+ ₹10L contingency)

Friday-Monday: Compliance check
  ├─ Email Legal: "Vendor GST registration check"
  ├─ Legal: "Is this vendor approved? Let me check"
  ├─ Not in approved list → negotiation
  └─ Finally approved Tuesday

Tuesday: Procurement approval
  ├─ Email Manager: "Ready to PO?"
  ├─ Manager: "Need specs review"
  ├─ Specs reviewed → Manager approves

Wednesday: Invoice + 3-way matching
  ├─ PO generated
  ├─ Vendor ships → invoice received
  ├─ Finance matches PO → invoice → receipt
  └─ Payment released (T+30 days typical)

Total time: 2-4 weeks (for a simple laptop purchase)
Cost: 10-20 hours of human time
Compliance gaps: Unknown (manual, error-prone)
```

**With Agentic Procurement (2-4 hours):**

```
Monday 9 AM: Procurement manager: "Agent, order 50 laptops"
  ↓
Agent (autonomous):
  Step 1: Search vendor catalogs (Dell, HP, Lenovo)
    ├─ Query: "50 laptops, 16GB RAM, <₹130K per unit"
    ├─ Response: Top 5 vendors, pricing, delivery time
    └─ Time: 2 seconds
  
  Step 2: Vendor compliance check
    ├─ Check: GST registration, past performance, ratings
    ├─ Filter: Only approved vendors
    └─ Time: 5 seconds
  
  Step 3: Contract lookup
    ├─ Check: Negotiated contracts for best vendor
    ├─ Price: ₹125K per unit (negotiated) vs. ₹130K (list)
    ├─ Discount: ₹2.5L total
    └─ Time: 3 seconds
  
  Step 4: Create PO
    ├─ PO details: 50 laptops × ₹125K = ₹62.5L
    ├─ Delivery: 7 days
    ├─ Warranty: 3 years
    └─ Time: 2 seconds
  
  Step 5: Route for approvals
    ├─ Amount: ₹62.5L → requires 3 approvals
    ├─ Auto-routes to:
    │  1. Budget owner (Finance VP)
    │  2. Procurement Manager
    │  3. CEO (if > ₹50L threshold)
    ├─ Notifications sent
    └─ Time: 1 second
  
  Step 6: Collect approvals (async)
    ├─ 10 AM: Finance VP approves (via Slack modal: "✅ APPROVE")
    ├─ 10:15 AM: Procurement Manager approves (same)
    ├─ 10:30 AM: CEO approves (same)
    └─ All approvals collected

Monday 10:45 AM: Agent executes
  ├─ All approvals collected
  ├─ Final compliance check passed
  ├─ PO auto-generated
  ├─ Invoice & receipt automatically matched (when vendor ships)
  ├─ Payment scheduled for net-30 days
  └─ Notifications sent to all stakeholders

Monday 11 AM: Procurement manager sees result
  ├─ Slack message: "✅ Order placed! 50 laptops, ₹62.5L, 7-day delivery"
  ├─ PO number: PO-2026-12345
  ├─ Link to full order details
  └─ Tracking link for delivery

Result: Complete procurement in 2 hours (vs. 2-4 weeks)
Cost: 10 minutes of human time
Compliance: 100% (automated enforcement)
Savings: ₹2.5L (negotiated discount vs. manual process)
```

### Sub-Problems

1. **Approval Routing Bottleneck**
   - Manual email chains (lots of back-and-forth)
   - Slow approval (people miss emails, take days to respond)
   - No visibility into approval status
   - Resubmit if rejected (start over)

2. **Vendor Compliance Gaps**
   - Manual checking (is vendor GST-compliant?)
   - No centralized approved vendor list
   - Risk: Unauthorized vendors getting POs
   - Time waste: Checking same vendor repeatedly

3. **Contract Integration Failure**
   - Procurement doesn't know negotiated pricing
   - Pays list price instead of negotiated price
   - Savings left on table (₹2-10L per order)

4. **3-Way Matching Complexity**
   - PO → Invoice → Receipt matching is manual
   - Discrepancies take days to resolve
   - Payment delays (can't close the order)

5. **Spend Visibility**
   - CFO can't see what procurement is buying
   - No spend analytics (which vendors, categories)
   - Can't identify consolidation opportunities (bulk discounts)

---

## MARKET SIZE & OPPORTUNITY

### Enterprise Procurement Market (India)

**Total Enterprise Spend (India):**
- Large companies (₹100Cr+ GMV): ~1,000 companies
- Mid-market (₹20-100Cr): ~5,000 companies
- SMB (₹5-20Cr): ~20,000 companies
- **Total addressable:** ₹1,000Cr+

**Razorpay Addressable Segment:**
- Corporate card + payment customers: ~2,000
- B2B clients: ~5,000
- **Target: Top 10K companies for Year 1-2**

**TAM Calculation:**

| Segment | Companies | Avg Annual Procurement Spend | Razorpay Take (0.5-1%) | Year 1 TAM |
|---------|-----------|-------|---|---|
| **Large Enterprise** | 1,000 | ₹500Cr | ₹2.5-5Cr per company | ₹25-50Cr |
| **Mid-Market** | 5,000 | ₹50Cr | ₹25-50L per company | ₹12.5-25Cr |
| **SMB** | 20,000 | ₹10Cr | ₹5-10L per company | ₹10-20Cr |
| **Total** | **26,000** | - | - | **₹47.5-95Cr** |

**Conservative Year 1:** ₹50Cr (0.5% of addressable market)

### Competitive Position

**No direct competitors** building agentic procurement.

Legacy competitors (SAP Ariba, Coupa) are:
- ❌ Not agentic-aware
- ❌ High complexity (6-12 month implementations)
- ❌ Expensive (₹10-50L+ annual)
- ❌ Slow to innovate

**Razorpay advantage:** Build fresh, agentic-first approach. 12+ month head start.

---

## TECHNICAL ARCHITECTURE

### Multi-Stakeholder Approval Engine

```
Smart Approval Routing:

Algorithm: Based on amount, category, vendor, budget owner

Example Rules:
┌─────────────────────────────────────────────────────────────┐
│ if amount ≤ ₹5L and vendor in approved_list and             │
│    category in pre_approved_categories:                      │
│   → AUTO_APPROVE (no human needed)                          │
│                                                               │
│ elif amount ≤ ₹25L:                                         │
│   → Route to Budget Owner only                              │
│   → If approved, execute immediately                        │
│                                                               │
│ elif amount ≤ ₹100L:                                        │
│   → Route to Budget Owner + Procurement Manager             │
│   → Both must approve (in parallel, within 24 hours)        │
│                                                               │
│ elif amount > ₹100L:                                        │
│   → Route to Budget Owner + Proc Manager + CFO              │
│   → CFO is final approver (must approve in 48 hours)        │
│                                                               │
│ else if vendor not in approved_list:                        │
│   → Route to Legal/Compliance first (check vendor)          │
│   → Then standard approval routing                          │
│                                                               │
│ else if category is restricted (e.g., travel):              │
│   → Route to HR first                                       │
│   → Then standard approval routing                          │
└─────────────────────────────────────────────────────────────┘

Notification Strategy:
┌─────────────────────────────────────────────────────────────┐
│ Approval notifications in order of preference:              │
│ 1. Slack modal (fastest response, 4-5 minutes)             │
│ 2. Email (if Slack fails, 24 hours)                        │
│ 3. SMS (for urgent high-value, 1-2 minutes)                │
│ 4. Mobile app push (30 seconds)                            │
│                                                               │
│ Approval modal example:                                     │
│ ┌──────────────────────────────────┐                       │
│ │ Procurement Approval Required     │                       │
│ ├──────────────────────────────────┤                       │
│ │                                   │                       │
│ │ PO: 50 laptops                   │                       │
│ │ Vendor: Dell                     │                       │
│ │ Amount: ₹62.5L                   │                       │
│ │ Delivery: 7 days                 │                       │
│ │                                   │                       │
│ │ [✅ APPROVE] [❌ REJECT] [? MORE INFO] │                       │
│ │                                   │                       │
│ └──────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────┘
```

### Vendor Compliance Engine

```
Real-Time Vendor Verification:

Before routing for approval, agent checks:

1. GST Registration
   ├─ Query GST database (GSTN API)
   ├─ Status: Active, Good standing
   └─ Compliance: ✅ PASS

2. Approved Vendor List (AVL)
   ├─ Is vendor in company's approved list?
   ├─ If no: Alert compliance officer for approval
   └─ Compliance: ✅ PASS (if approved)

3. Past Performance Scoring
   ├─ On-time delivery rate: 98%
   ├─ Quality rating: 4.7/5
   ├─ Return rate: 2% (industry avg: 5%)
   └─ Performance Score: 85/100 (good)

4. Financial Health Check
   ├─ Is vendor financially stable?
   ├─ Check: Payment history, credit rating
   └─ Risk: LOW

5. Contractual Terms
   ├─ Negotiated discount: Yes (15%)
   ├─ Warranty: 3 years (vs. standard 1 year)
   ├─ SLA: 24-hour response time
   └─ Terms: FAVORABLE

Output:
┌──────────────────────────────────────────┐
│ Vendor Risk Score: 8/100 (LOW)           │
│ Recommendation: ✅ APPROVE               │
│ Negotiated Savings: ₹2.5L                │
└──────────────────────────────────────────┘
```

### Contract Integration

```
Dynamic Pricing from Contracts:

Scenario: Agent needs to buy laptops from Dell

Process:
1. Agent queries: "Best price for Dell laptops (16GB, SSD)"
2. System checks: "Do we have a contract with Dell?"
3. If YES:
   ├─ Pull negotiated rate: ₹125K per unit (vs. ₹130K list)
   ├─ Volume discount: 15% (if ordering 50+)
   ├─ Apply discount: ₹50 × ₹125K × (1 - 0.15) = ₹53.125L
   └─ Quote: ₹53.125L (vs. ₹65L without negotiation)
4. If NO:
   ├─ Get list price
   ├─ Suggest negotiation with vendor
   └─ Create RFQ (Request for Quote)

Benefits:
✅ Automatic discount application (no manual negotiation)
✅ Visibility into actual contract terms
✅ Savings enforcement (can't overpay)
✅ Contract compliance (can't buy unauthorized items)
```

### Real-Time 3-Way Matching

```
Traditional 3-Way Matching (Manual, Error-Prone):
┌─────────────────────────────────────────────────────┐
│ Week 1: PO created (₹62.5L)                        │
│ Week 2: Vendor ships, invoice received (₹62.5L)    │
│ Week 3: Receipt received (quantity check)          │
│ Week 4: Finance manually matches                    │
│   ├─ PO vs Invoice: Match ✅                        │
│   ├─ PO vs Receipt: Discrepancy ⚠️                  │
│   │  └─ PO: 50 laptops, Receipt: 48 laptops        │
│   ├─ Holds payment for dispute resolution          │
│   └─ Back-and-forth emails (3-5 days)              │
│ Week 5: Discrepancy resolved, payment released     │
└─────────────────────────────────────────────────────┘

With Agentic 3-Way Matching (Automated):
┌─────────────────────────────────────────────────────┐
│ PO Created (Day 1)                                  │
│ └─ Stored in system: amount, qty, specs            │
│                                                     │
│ Invoice Received (Day 3)                            │
│ └─ Auto-extract: amount, qty, line items           │
│ └─ Compare vs PO (automated):                       │
│    ├─ Amount match: ₹62.5L == ₹62.5L ✅            │
│    ├─ Items match: 50 laptops == 50 laptops ✅     │
│    └─ Status: AUTO_MATCHED                         │
│                                                     │
│ Receipt Received (Day 5)                            │
│ └─ Auto-extract: qty received, condition check     │
│ └─ Compare vs PO + Invoice:                         │
│    ├─ Qty match: 50 received == 50 ordered ✅      │
│    ├─ Specs match: 16GB RAM, SSD ✅                │
│    └─ Status: READY_FOR_PAYMENT                    │
│                                                     │
│ Payment Released (Day 6)                            │
│ └─ All 3 match, no discrepancies                   │
│ └─ Payment auto-released on net-30 terms           │
│ └─ Time: 3 days (vs 2+ weeks manual)               │
└─────────────────────────────────────────────────────┘
```

---

## IMPLEMENTATION ROADMAP

### Phase 1: MVP (Weeks 1-8)

**Scope:**
1. Multi-stakeholder approval engine (smart routing)
2. Purchase order generation + management
3. Vendor compliance checking (basic)
4. Real-time 3-way matching
5. Basic spend analytics
6. Slack integration for approvals

**Tech Stack:**
- Python (rule engine for approval routing)
- PostgreSQL (PO storage, matching logic)
- Kafka (real-time document matching)
- FastAPI (APIs)
- React (dashboard)
- Slack API (approval notifications)

**Team:** 2 backend engineers, 1 data engineer, 1 frontend engineer, 1 product manager

**Deliverables:**
- PO creation API
- Approval routing engine
- Vendor verification service
- 3-way matching system
- Approval dashboard (Slack + web)

### Phase 2: Scale (Weeks 9-16)

**Scope:**
1. Contract integration (pull negotiated pricing)
2. Advanced spend analytics (cohort analysis)
3. RFQ (Request for Quote) generation
4. Multi-vendor comparison
5. Supplier management portal
6. API integrations (ERP systems: SAP, Oracle)

**Team:** +1 integration engineer, +1 data scientist

### Phase 3: Productize (Weeks 17-24)

**Scope:**
1. Invoice-to-PO matching (automatic)
2. Tax invoice validation (GST compliance)
3. White-label for other payment processors
4. API marketplace
5. Advanced fraud detection (vendor fraud)

---

## MVP FEATURES

### Feature 1: PO Creation & Approval Flow

```
User (Procurement Manager): "Agent, order 50 laptops"

Agent creates PO with:
- Vendor: Dell (compliance ✅)
- Quantity: 50 units
- Unit price: ₹125K (negotiated rate)
- Total: ₹62.5L
- Delivery: 7 days
- Terms: Net-30

Approval Routing:
Amount ₹62.5L → Requires: Budget Owner + CFO

Slack notifications sent to both:
┌──────────────────────────────────┐
│ PO Approval Required             │
├──────────────────────────────────┤
│ Vendor: Dell                     │
│ Items: 50 laptops (16GB RAM)     │
│ Total: ₹62.5L                    │
│ Vendor Score: 85/100 ✅          │
│ Contract Savings: ₹2.5L ✅       │
│                                   │
│ [✅ APPROVE] [❌ REJECT] [INFO]   │
│                                   │
└──────────────────────────────────┘

Both approve within 2 hours:
- Budget Owner approves 1:15 PM
- CFO approves 2:45 PM

Agent executes immediately:
- PO created: PO-2026-0512
- Vendor notified
- Tracking link sent to team
- Calendar block created (delivery window)
```

### Feature 2: Real-Time Vendor Verification

```
Dashboard showing vendor compliance:

┌──────────────────────────────────────────────────┐
│ Vendor Compliance Report                        │
├──────────────────────────────────────────────────┤
│                                                   │
│ Vendor: Dell                                     │
│ ID: dell_ind_001                                │
│                                                   │
│ ✅ GST Registration: 27AAGCD1234H1Z0             │
│    Status: Active, Good standing                │
│    Verified: 2026-08-02                         │
│                                                   │
│ ✅ Approved Vendor List: Yes                    │
│    Added: 2024-01-15                            │
│    Rating: 4.7/5 (98 reviews)                  │
│                                                   │
│ ✅ Performance Score: 85/100                    │
│    On-time delivery: 98%                        │
│    Quality rating: 4.7/5                        │
│    Return rate: 2%                              │
│                                                   │
│ ✅ Financial Health: Stable                     │
│    Credit rating: AAA                           │
│    Payment history: Excellent                   │
│                                                   │
│ ✅ Contract Terms: FAVORABLE                    │
│    Base discount: 15%                           │
│    Volume discount: 5% (50+ units)              │
│    Warranty: 3 years                            │
│                                                   │
│ Overall Risk: LOW (8/100)                       │
│ Recommendation: ✅ APPROVE                      │
│                                                   │
└──────────────────────────────────────────────────┘
```

### Feature 3: Spend Analytics Dashboard

```
CFO Dashboard: Real-Time Spend Visibility

┌──────────────────────────────────────────────┐
│ Procurement Analytics (YTD 2026)            │
├──────────────────────────────────────────────┤
│                                               │
│ Total Spend: ₹250Cr                          │
│ Savings (negotiated): ₹12.5Cr (5%)           │
│ On-budget: 98%                               │
│ Vendor concentration: 42% (top 10)           │
│                                               │
│ Spend by Category:                           │
│ ┌─────────────────────────────────────────┐ │
│ │ IT Equipment:    ₹75Cr  (30%)           │ │
│ │ Office Supplies: ₹40Cr  (16%)           │ │
│ │ Travel:          ₹60Cr  (24%)           │ │
│ │ Utilities:       ₹50Cr  (20%)           │ │
│ │ Other:           ₹25Cr  (10%)           │ │
│ └─────────────────────────────────────────┘ │
│                                               │
│ Top Vendors (by spend):                      │
│ 1. Dell: ₹45Cr (negotiated discount: 15%)  │
│ 2. HP: ₹30Cr (negotiated discount: 12%)    │
│ 3. Lenovo: ₹25Cr (negotiated discount: 10%)│
│                                               │
│ Consolidation Opportunity:                   │
│ "Vendors #3-10 can be consolidated to       │
│  top 3, saving ₹8Cr annually"               │
│                                               │
└──────────────────────────────────────────────┘
```

---

## FINANCIAL MODEL

### Revenue Model

1. **Platform Fee:** 0.5-1% of procurement volume
2. **Contract Fee:** ₹10-50L one-time (contract integration)
3. **Analytics Premium:** ₹10-50L annual (advanced analytics)
4. **Supplier Portal:** ₹5-10L annual (vendor management)

### Year 1 Projections

- **Customers:** 500 companies
- **Avg spend per customer:** ₹50Cr
- **Total volume:** ₹25,000Cr
- **Revenue (0.5%):** ₹125Cr
- **Conservative (0.25%):** ₹62.5Cr
- **Target Year 1:** ₹50Cr

### Unit Economics

- **CAC:** ₹50-100K per enterprise
- **Payback:** 2-3 months
- **LTV (3-year):** ₹250L+
- **Gross margin:** 80%+

---

## EXISTING COMPETITORS & COMPARISON

| Player | Strength | Weakness | Agentic-Ready? |
|--------|----------|----------|---|
| **SAP Ariba** | Established, large user base | Complex, slow, expensive | ❌ |
| **Coupa** | Modern UI, market leader | Not agentic, requires implementation | ⚠️ |
| **TripActions** | Fast setup, travel-focused | Travel-only, can't generalize | ❌ |
| **Razorpay EAPN** | ✅ Agentic-first, payment integration, fast setup | New product | ✅✅ |

---

## SUCCESS METRICS

**North Star:** ₹500Cr annual procurement volume on platform

**Leading Indicators:**
- 500 companies onboarded
- Avg PO processing time < 4 hours
- Approval acceptance rate > 90%
- Vendor compliance: 100%

**Financial:**
- MRR: ₹4Cr+
- CAC: < ₹100K
- LTV: > ₹250L

---

**Document Version:** 1.0 | **Last Updated:** 2026-08-31

