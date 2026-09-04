# IDEA #6: AGENT FRAUD & RISK INTELLIGENCE (AFRI)
## Real-Time Behavioral Anomaly Detection & Fraud Prevention

**Status:** Investable Pitch-Ready | **Priority:** P0 (Parallel with AGE + ATCE) | **Timeline:** MVP in 8-10 weeks

---

## EXECUTIVE SUMMARY

**What:** ML-powered fraud detection engine that identifies rogue agents, account compromises, and merchant fraud rings in real-time—protecting the agentic commerce ecosystem.

**Why:**
- **Agents can make 1,000+ transactions/day** (vs. humans: 10-50)
- **Fraud patterns invisible to traditional payment networks**
- **Estimated fraud loss:** $100M-$500M globally in agentic channel (if unaddressed)
- **Zero fraud detection solution exists for agentic commerce** (greenfield)
- **Only Razorpay sees full agentic transaction patterns** (data moat)

**How:**
- Train ML models on 100M+ Razorpay transactions
- Detect anomalies: velocity spikes, mandate violations, behavioral changes
- Real-time flagging + blocking of suspicious transactions
- Merchant risk scoring (identify fraud rings)
- Regulatory reporting (SARs for FinCEN, RBI, etc.)

**Market Impact:**
- **Year 1 Revenue:** ₹40-60Cr
- **TAM (Global):** ₹200Cr+
- **Fraud Prevention Value:** $1B+ (across ecosystem)

**Why Now:**
1. Agentic commerce fraud is starting to emerge (need to get ahead)
2. Regulatory pressure (FinCEN PPSI rule mandates fraud detection)
3. Razorpay has data advantage (only player with full visibility)
4. 6-12 month head start before competitors build this

---

## PROBLEM STATEMENT

### The Core Problem: Agentic Fraud is Invisible

**Example Fraud Scenarios:**

```
Scenario 1: Runaway Agent Loop (Infinite Transactions)

Monday 2 PM: User gives agent ₹5K spending limit
Agent: "Order me lunch from Zomato"

Agent incorrectly loops:
- Places order 1: ₹500 (normal)
- Places order 2: ₹500 (normal)
- Places order 3: ₹500 (normal)
- ...
- Places order 25: ₹500 (PROBLEM! User didn't authorize 25 meals)
- Total spent: ₹12,500 (exceeded ₹5K limit)

Traditional fraud detection:
- ❌ Missed by normal velocity checks (5 orders/hour = normal for food delivery)
- ❌ Missed by spending limit check (but only checked BEFORE payment)
- Result: User charges ₹7.5K unauthorized

With AFRI:
- ✅ Detected: Identical transactions (same merchant, same amount, same items)
- ✅ Detected: Unusual pattern (5 orders in 2 minutes)
- ✅ Detected: Agent exceeded daily meal budget
- ✅ Action: Block transaction 6, notify user
- Result: User loses only ₹500 (detectable error, not fraud)

---

Scenario 2: Hacked Account (Account Takeover)

Normal Behavior:
- User: Buys groceries from Bigbasket (Mon-Fri, ₹300-500 orders)
- Time: 10 AM - 4 PM
- Days: Weekdays only
- Merchant diversity: 3 merchants (Bigbasket, Amazon, Flipkart)

Attack:
Hacker compromises user's Razorpay account
- Midnight: Suddenly orders ₹50K worth of electronics from unknown vendor
- Device: Different IP, different device fingerprint
- Merchant: Unknown to user (not in any historical data)

Traditional fraud detection:
- ❌ Behavior changed, but no rule-based system caught it
- ❌ Large amount, but spending limit is ₹1K per transaction (failed here)
- ❌ But account compromise not detected
- Result: ₹50K fraud goes through

With AFRI:
- ✅ Detected: Behavioral deviation (anomalous time, device, merchant)
- ✅ Detected: Large amount + new merchant = high risk
- ✅ Detected: Device fingerprint mismatch
- ✅ Action: Block transaction, send OTP verification
- Result: ₹0 fraud loss (prevented)

---

Scenario 3: Merchant Fraud Ring

Merchant A (legitimate): Accepts agentic orders
Merchant B (colluding): Partner in fraud
Merchant C (fake): Created just for this scheme

Scheme:
1. Merchant A gets order from Agent (real user, ₹10K)
2. Merchant A transfers goods to Merchant B (no payment)
3. Merchant B "orders" via agent (fake order, ₹10K fake transaction)
4. Money goes to Merchant B (while Merchant A sends goods)
5. Repeat 100x per day = ₹10L daily fraud

Traditional fraud detection:
- ❌ Each transaction looks normal individually
- ❌ Spending limit checks pass (within limits)
- ❌ Mandate checks pass (merchant is in whitelist)
- Result: Undetected fraud ring ($100K+ per week)

With AFRI:
- ✅ Detected: Unusual co-purchase patterns (same agents buying from Merchant B every time)
- ✅ Detected: Merchant B has 60% return rate (red flag)
- ✅ Detected: Graph analysis (Merchant A → B edge is suspicious)
- ✅ Detected: High concurrent transactions (100+ agents ordering simultaneously)
- ✅ Action: Flag merchants, alert compliance team
- Result: Ring exposed, prevented before scaling
```

### Sub-Problems

1. **Agent Behavioral Anomalies**
   - Agents have different patterns than humans
   - Normal for agents to make 100+ transactions/hour
   - Hard to distinguish runaway loop from legitimate bulk ordering

2. **Fraud Ring Detection**
   - Requires graph analysis (which merchants interact?)
   - Colluding merchants hide their relationship
   - Pattern: Abnormal return rates, shipping delays, etc.

3. **Account Compromise Detection**
   - Device fingerprinting (IP, browser, device)
   - Behavioral baseline deviation
   - Usual merchants vs. new merchants

4. **Velocity Abuse**
   - Agents can exceed limits if loop happens
   - Spending limit check is pre-authorization
   - Post-authorization, need velocity cap

5. **Regulatory Reporting**
   - Suspicious Activity Reports (SARs) required
   - FinCEN PPSI rule: PPSIs must file SARs
   - Manual SARs are expensive, slow
   - Need automated SAR generation

---

## MARKET SIZE & OPPORTUNITY

### Fraud Volume in Agentic Commerce

**Estimated Global Fraud (2026):**
- Agentic commerce volume: $7.7B (market research)
- Fraud rate (industry standard): 0.5-2% of transactions
- Estimated fraud: $38.5M - $154M annually
- Growth to 2028: Likely 2-3x (as scale increases)

**By Category:**
- Agent behavioral (loop, hallucination): 40%
- Account compromise: 35%
- Merchant fraud rings: 15%
- Other: 10%

### Revenue Opportunities

| Customer Segment | Size | Price | TAM |
|---|---|---|---|
| **Merchants (Detection Service)** | 10,000 | ₹10-50K/month | ₹120-600Cr |
| **Payment Processors (White-label)** | 50 | ₹50-500K/month | ₹30-300Cr |
| **Insurance (Risk Models)** | 50 | ₹100K-1M/month | ₹60-600Cr |
| **Compliance/Regulatory** | 100+ | ₹50K-500K/month | ₹60-600Cr |
| **Total TAM** | - | - | **₹270Cr - ₹2,100Cr** |

**Conservative Year 1:** ₹40-60Cr

---

## TECHNICAL ARCHITECTURE

### ML Model Stack

#### Model 1: Agent Behavior Anomaly Detection

```
Algorithm: Isolation Forest + LSTM (temporal patterns)

Features:
├─ Velocity features:
│  ├─ Transactions per hour
│  ├─ Transactions per day
│  ├─ Transaction amount distribution
│  └─ Time between transactions
│
├─ Behavioral features:
│  ├─ Agent consistency (same agent, different behavior?)
│  ├─ Merchant diversity (how many different merchants?)
│  ├─ Time-of-day patterns (normal hours vs. midnight spikes?)
│  └─ Category consistency (usual categories vs. new categories?)
│
├─ Financial features:
│  ├─ Amount distribution (avg, stdev, percentiles)
│  ├─ Total daily spend
│  ├─ Largest transaction ever
│  └─ Spending pattern deviation
│
└─ Device features:
   ├─ IP address changes
   ├─ Device fingerprint (browser, OS, etc.)
   ├─ Geographic location jumps
   └─ User agent string changes

Training Data: 100M+ Razorpay transactions

Anomaly Score Interpretation:
├─ 0-30: Normal (green)
├─ 30-60: Suspicious (yellow) → Manual review
├─ 60-90: High risk (orange) → Block + OTP challenge
└─ 90-100: Critical (red) → Block immediately

Output:
{
  "agent_id": "claude-agentic-v1",
  "user_id": "user_123",
  "anomaly_score": 78,
  "risk_level": "HIGH",
  "anomalies_detected": [
    "Velocity spike: 5x normal (10 txns/min vs. 2/min average)",
    "Identical transactions: Same amount, same merchant, 60 seconds apart",
    "New merchant: Not in user's transaction history"
  ],
  "recommended_action": "BLOCK + OTP_CHALLENGE"
}
```

#### Model 2: Account Compromise Detection

```
Algorithm: Autoencoder + Temporal Clustering

Baseline User Profile:
├─ Typical merchants: [Bigbasket, Amazon, Flipkart]
├─ Typical amount: ₹300-500
├─ Typical hours: 10 AM - 4 PM
├─ Typical device: iPhone 13, iOS 16, Safari
├─ Typical locations: Home, Office
└─ Typical frequency: 2-3 orders per day

Compromise Signals:
├─ Large amount + new merchant + midnight: ⚠️⚠️⚠️
├─ New device + new IP + new location: ⚠️⚠️⚠️
├─ Vendor category mismatch: ⚠️
├─ Behavioral deviation: ⚠️
└─ Multiple risk signals: 🚨 BLOCK

Autoencoder:
- Encodes normal behavior into latent vector
- Large reconstruction error = anomaly
- Output: Compromise probability (0-100)
```

#### Model 3: Merchant Fraud Ring Detection

```
Algorithm: Graph Neural Networks (GNN)

Graph Structure:
- Nodes: Merchants
- Edges: Co-purchases (agent buys from both merchants)
- Edge weight: Frequency + amount

Fraud Ring Signals:
├─ Unusual co-purchase patterns
│  ├─ Agents buying from Merchant A → B together
│  ├─ No legitimate reason for pairing
│  └─ Pattern: Hidden relationship
│
├─ Abnormal return rates
│  ├─ Merchant B: 60% return rate (industry avg: 5%)
│  ├─ Returns go to Merchant A (unusual)
│  └─ Pattern: Goods flow, money hidden
│
├─ High concurrent transaction velocity
│  ├─ 500+ agents ordering simultaneously
│  ├─ All from same merchant pairing
│  └─ Pattern: Coordinated fraud
│
└─ Financial flow analysis
   ├─ Merchant A → Merchant B → Shell company
   ├─ Money never settled to A
   └─ Pattern: Fraud ring structure

Output:
{
  "merchant_ids": ["merchant_a_id", "merchant_b_id"],
  "fraud_ring_probability": 0.89,
  "evidence": [
    "Co-purchase frequency: 2,500 agents in common",
    "Return rate for Merchant B: 62% (vs. 5% industry avg)",
    "Money flow: ₹50Cr in (from agents) → ₹0 out to Merchant A",
    "Concurrent velocity: 1,000 orders in 5 minutes"
  ],
  "recommended_action": "SUSPEND_MERCHANTS + INVESTIGATE"
}
```

#### Model 4: Fraud Likelihood Scoring

```
Composite Score:
fraud_score = 0.3 * agent_anomaly + 0.3 * account_compromise + 0.4 * transaction_risk

Transaction Risk Features:
├─ New merchant risk: 0-1 (is merchant known?)
├─ Amount risk: 0-1 (is amount unusual?)
├─ Mandate violation risk: 0-1 (violates user rules?)
├─ Velocity risk: 0-1 (too many txns?)
└─ Category risk: 0-1 (blacklisted category?)

Final Score:
├─ 0-20: Approve (no review needed)
├─ 20-50: Approve + log (monitor)
├─ 50-80: Challenge (OTP, CVC verification)
├─ 80-100: Decline (block transaction)

Auto-tuning:
- Model retrains weekly
- Feedback loop: Merchants mark as false positive
- Precision target: 95%+
```

---

## IMPLEMENTATION ROADMAP

### Phase 1: MVP (Weeks 1-8)

**Scope:**
1. Agent behavior anomaly detection (Isolation Forest)
2. Account compromise detection (Autoencoder)
3. Real-time transaction scoring
4. Fraud dashboard (Razorpay + merchant)
5. SAR auto-generation (template)
6. Slack integration for alerts

**Team:** 2 ML engineers, 1 backend engineer, 1 data engineer, 1 frontend engineer

**Deliverables:**
- Anomaly detection API
- Fraud scoring engine
- Real-time blocking mechanism
- Dashboard (view suspicious transactions)
- SAR generation template

### Phase 2: Scale (Weeks 9-16)

**Scope:**
1. Merchant fraud ring detection (GNN)
2. Advanced patterns (account compromise)
3. White-label for payment processors
4. Regulatory SAR API (for RBI/FinCEN)
5. Insurance partnership integration

**Team:** +1 data scientist, +1 partnerships manager

### Phase 3: Productize (Weeks 17-24)

**Scope:**
1. Multi-region fraud detection (ASEAN, LATAM)
2. Industry-specific models (e-commerce, fintech, etc.)
3. Feedback mechanisms (merchants marking false positives)
4. Advanced analytics (fraud trends, hotspots)

---

## MVP FEATURES

### Feature 1: Real-Time Fraud Detection Dashboard

```
┌──────────────────────────────────────────────────────────┐
│ Real-Time Fraud Alerts (Last 24 Hours)                  │
├──────────────────────────────────────────────────────────┤
│                                                            │
│ 🔴 CRITICAL (2)                                          │
│                                                            │
│ 1. Account Compromise Detected                           │
│    User: user_456                                        │
│    Risk Score: 92/100                                    │
│    Signal: Device change + midnight purchase             │
│    Amount: ₹50K (5x usual max)                           │
│    New Merchant: Unknown electronics vendor              │
│    Action Taken: ✅ BLOCKED                             │
│    User Notified: Yes (OTP sent)                         │
│                                                            │
│ 2. Fraud Ring Activity Detected                          │
│    Merchants: merchant_a_id, merchant_b_id              │
│    Evidence: 2,500 co-purchases, 62% return rate        │
│    Estimated Loss: ₹50Cr                                │
│    Action Needed: [Suspend] [Investigate] [Mark False]  │
│                                                            │
│ 🟠 HIGH (8)                                              │
│                                                            │
│ Velocity Spike: Agent placing 100 orders in 5 minutes   │
│ Risk: 78/100 → ACTION: Challenge user                   │
│                                                            │
│ Device Fingerprint Change: Known user, new device       │
│ Risk: 65/100 → ACTION: Log, monitor                     │
│                                                            │
│ ... [6 more HIGH alerts] ...                            │
│                                                            │
│ 🟡 MEDIUM (25)                                           │
│                                                            │
│ Category Velocity: User buying from 10 new merchants    │
│ Risk: 45/100 → ACTION: Monitor                          │
│                                                            │
│ ... [24 more MEDIUM alerts] ...                         │
│                                                            │
└──────────────────────────────────────────────────────────┘
```

### Feature 2: Transaction Risk Scoring (Real-Time)

```
Transaction Scoring API:

Request:
{
  "agent_id": "claude-v1-9f2e",
  "user_id": "user_123",
  "merchant_id": "bigbasket",
  "amount_inr": 487,
  "user_device": {
    "ip": "203.0.113.45",
    "device_fingerprint": "iphone_13_safari",
    "location": "bangalore"
  }
}

Response (< 50ms):
{
  "fraud_score": 12,
  "risk_level": "LOW",
  "recommendation": "APPROVE",
  "component_scores": {
    "agent_anomaly": 5,
    "account_compromise": 8,
    "merchant_risk": 15,
    "velocity_risk": 5,
    "category_risk": 0
  },
  "reasoning": [
    "Agent behavior: Normal",
    "Account: No compromise signals",
    "Merchant: Known merchant (5+ prior txns)",
    "Velocity: 1 txn in last hour (normal)",
    "Category: Allowed (groceries)"
  ]
}
```

### Feature 3: Automated SAR Generation

```
Suspicious Activity Report (SAR) Auto-Generation:

Trigger: Transaction with fraud_score > 80

Auto-Generated SAR (FinCEN Form 111):

SAR Report ID: SAR_20260802_001
Date Initiated: 2026-08-02
Reporting Institution: Razorpay (PPSI)

Suspicious Activity Summary:
├─ Activity Type: Account takeover, unauthorized transactions
├─ Amount: ₹50,000
├─ Customer: user_456 (verified identity)
├─ Transaction: Merchant xyz, electronics, midnight
├─ Indicators: Device change, new merchant, large amount
├─ Anomaly Detection: ML model scored 92/100 risk

Detection Method:
├─ Real-time behavioral anomaly detection
├─ Graph neural network analysis
├─ Device fingerprinting
└─ Account baseline comparison

Actions Taken:
├─ Transaction blocked
├─ User notified via SMS + app push
├─ OTP verification requested
├─ Investigation initiated

Status: REPORTED_TO_FINANCIAL_INTELLIGENCE_UNIT
Narrative: [Auto-generated detailed description]

Result:
✅ FinCEN can automatically ingest this report
✅ Razorpay complies with PPSI SAR requirements
✅ Turnaround: < 1 hour (vs. manual: days)
```

### Feature 4: Merchant Fraud Ring Detection Dashboard

```
Fraud Ring Monitoring:

┌───────────────────────────────────────────┐
│ Suspected Fraud Rings (Last 30 Days)      │
├───────────────────────────────────────────┤
│                                            │
│ Ring #1: CRITICAL                         │
│ ├─ Merchants: A, B (identified)           │
│ ├─ Estimated Loss: ₹50Cr                  │
│ ├─ Pattern: Co-purchases, high returns    │
│ ├─ Co-purchase count: 2,500 agents        │
│ ├─ Status: Under Investigation            │
│ ├─ Action: [View Details] [Suspend] [Notify] │
│ └─ Timeline: Detected 2026-08-01          │
│                                            │
│ Ring #2: HIGH                              │
│ ├─ Merchants: C, D, E (3-merchant ring)   │
│ ├─ Estimated Loss: ₹20Cr                  │
│ ├─ Pattern: Cross-merchant return scheme  │
│ ├─ Status: Escalated to Compliance        │
│ └─ Timeline: Detected 2026-07-28          │
│                                            │
│ ... [more rings] ...                      │
│                                            │
└───────────────────────────────────────────┘
```

---

## FINANCIAL MODEL

### Revenue Model

1. **Merchants (Detection Service):**
   - ₹10-50K/month per merchant
   - Target: 5,000 merchants
   - Year 1: ₹30Cr

2. **Payment Processors (White-Label):**
   - ₹50-500K/month per processor
   - Target: 20 processors
   - Year 1: ₹10Cr

3. **Insurance Partnerships:**
   - Referral revenue (insurance premium discounts)
   - Risk models licensing
   - Year 1: ₹5Cr

4. **Regulatory Data:**
   - RBI, FinCEN, EU agencies buy anonymized fraud data
   - Year 1: ₹2Cr

**Total Year 1:** ₹47Cr (conservative)

---

## EXISTING COMPETITORS

**Direct Competitors:** None (agentic-specific fraud detection doesn't exist)

**Indirect Competitors:**
- **Stripe Radar:** Payment fraud detection (but not agentic-aware)
- **ACI Worldwide:** Card fraud detection (legacy)
- **FICO Falcon:** Risk scoring (non-agentic)

**Razorpay Advantage:**
- ✅ Unique data (only sees full agentic patterns)
- ✅ Behavioral baselines (100M+ transactions)
- ✅ First-mover (6-12 month head start)
- ✅ Native integration (can block at payment level)

---

## RISK & MITIGATION

### Risk 1: False Positive Rate (Blocking Legitimate Transactions)

**Risk:** Too many false positives → merchant frustration → churn

**Mitigation:**
- Conservative tuning (target: 95%+ precision)
- Human-in-loop (challenge users instead of blocking)
- Feedback loop (merchants mark false positives)
- A/B testing (validate new models before rollout)

### Risk 2: Adversarial Fraud Attacks

**Risk:** Fraudsters adapt to avoid detection rules

**Mitigation:**
- Update models weekly (retrain on new fraud patterns)
- Adversarial testing (red team exercises)
- Behavioral patterns (hard to evade long-term patterns)
- Graph analysis (colluding merchants harder to hide)

### Risk 3: Regulatory Liability

**Risk:** FinCEN/RBI questions SAR reports; Razorpay liable for inaccuracy

**Mitigation:**
- Conservative scoring (over-report rather than under-report)
- Human review before SARs sent (week 1-4)
- Legal review of SAR methodology
- Insurance for cyber liability

---

## SUCCESS METRICS

### North Star

**Fraud Prevention Rate:** 90%+ of frauds detected before settlement

**Leading Indicators:**
1. **Detection Accuracy:** 95%+ precision (few false positives)
2. **False Positive Rate:** <5% (merchants not annoyed)
3. **Merchants Using Service:** 5,000+ by end of Year 1
4. **Fraud Blocked:** ₹100Cr+ annually

### Financial Metrics

1. **MRR:** ₹3-5Cr by end of Year 1
2. **CAC:** < ₹20K per merchant
3. **LTV:** > ₹100L per merchant (3-year)

---

**Document Version:** 1.0 | **Last Updated:** 2026-08-31

