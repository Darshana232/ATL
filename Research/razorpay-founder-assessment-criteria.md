# Razorpay Buildathon: Founder's Assessment Criteria
## Harshil Mathur's Non-Negotiable Standards for Track 1

**This is the quality bar.** Every decision, every feature, every line of code gets checked against these criteria.

---

## MANDATORY: Prototype Must-Haves (A1-A8)

### ✅ A1: Explainability — Every Agent Decision Has Clear Reasoning

**Standard:** Agent never decides without explaining *why*. Merchant can read the decision and understand the logic.

**What passes:**
- ✅ "15% discount — Why? This consumer converts at 12-18% range, abandoned 3x when price > $100, last 5 purchases avg $87. They've never responded to social proof."
- ✅ Agent shows: Signal → Insight → Action chain
- ✅ Merchant reads it and says "that makes sense"

**What fails:**
- ❌ "Recommended offer" (vague, no reasoning)
- ❌ "ML model says 15%" (black box, unexplainable)
- ❌ Agent makes decision silently, user doesn't know why

**Why this matters:** Merchants won't trust decisions they don't understand. Explainability is non-negotiable.

---

### ✅ A2: Real, Messy Data — Not Clean Personas

**Standard:** Test data reflects reality — overlapping patterns, contradictions, edge cases, noise.

**What passes:**
- ✅ Consumer A: Sometimes abandons on price ($100 limit), sometimes pays full price ($120 impulse)
- ✅ Consumer B: Reads reviews 70% of time, occasionally skips and buys
- ✅ Consumer C: Usually buys morning (post-salary), sometimes evening
- ✅ Data includes failures ("abandoned 10x in a row")
- ✅ Personas are messy, realistic, context-dependent

**What fails:**
- ❌ Perfect segmentation ("price-seeker" vs "review-reader" with zero overlap)
- ❌ Clean personas that only work in ideal conditions
- ❌ Cherry-picked data (no edge cases, no contradictions)

**Why this matters:** Clean personas work in demo but break in real world. Real data tests robustness.

---

### ✅ A3: Edge Cases Handled

**Standard:** Prototype shows you've thought through failure modes, not just happy path.

**What passes:**
- ✅ **New consumer (no history):** Agent decides on baseline/default, doesn't crash
- ✅ **Loyal customer abandons:** Agent notices deviation, investigates
- ✅ **Payment failure:** Agent offers alternative method (UPI/EMI)
- ✅ **Data contradictions:** "Consumer abandoned at $95 but bought at $100" — system handles it
- ✅ **Consumer reviews as negative post-purchase:** Agent learns hidden signal

**What fails:**
- ❌ "Prototype only works on ideal cases"
- ❌ "Breaks when consumer doesn't have history"
- ❌ "Payment failures not handled"
- ❌ "Contradictory data breaks the system"

**Why this matters:** Real world is messy. If you only handle happy path, you fail on launch.

---

### ✅ A4: Measured Impact with Specific Metrics

**Standard:** Not "seems like it would work" but "here are the numbers."

**What passes:**
- ✅ "Baseline: 71% abandonment. With agent: 63% (8pp improvement)"
- ✅ "For $1M revenue merchant: +$57K additional annual revenue"
- ✅ "Breakdown: 5pp from right discount, 2pp from UPI option, 1pp from social proof"
- ✅ "Conservative / stretch / if X assumption holds"
- ✅ Numbers are defendable, not made up

**What fails:**
- ❌ "Our agent recovers more carts" (how much?)
- ❌ "Seems like it would work" (vague)
- ❌ Numbers without baseline
- ❌ Inflated projections without reasoning

**Why this matters:** Founders care about metrics. This is how you prove impact.

---

### ✅ A5: Razorpay Leverage Demonstrated

**Standard:** Prototype shows *why this only works inside Razorpay*, not some generic SaaS.

**What passes:**
- ✅ "We see payment failures. Competitors monitoring from outside don't."
- ✅ "We're inside checkout. They're outside."
- ✅ "We know which payments failed, which retried, which succeeded. That's Razorpay-only data."
- ✅ Example: "Consumer has 40% retry rate on card failure, prefers UPI — only Razorpay sees this"
- ✅ Cross-merchant insights: "Apparel segment converts at 15% discount across all merchants"

**What fails:**
- ❌ Idea could work on Shopify, Stripe, Square (generic tool)
- ❌ Doesn't use any payment-flow-specific data
- ❌ Could be built by a standalone SaaS company

**Why this matters:** Differentiation = defensibility. Razorpay needs a moat.

---

### ✅ A6: Privacy & Compliance Addressed

**Standard:** You've thought through data risks and mitigated them. Not ignored.

**What passes:**
- ✅ "We anonymize consumer data, merchants opt-in, all interventions logged"
- ✅ "We comply with DPDP Act (India), GDPR (EU merchants), emerging compliance"
- ✅ "Consumers can request data deletion"
- ✅ "Merchants see/approve which signals we track"
- ✅ "Audit trail for every decision"

**What fails:**
- ❌ Zero mention of privacy/compliance (major red flag)
- ❌ "We'll figure it out later"
- ❌ Tracking sensitive data without consent framework
- ❌ No transparency to merchants about data use

**Why this matters:** One regulator complaint = entire product halted. You must get this right from the start.

---

### ✅ A7: Learning Curve Visible

**Standard:** Agent visibly improves over time. Not same logic for all.

**What passes:**
- ✅ **Transaction 1:** Conservative personalization (minimal data)
- ✅ **Transaction 5:** More confident decisions (pattern emerging)
- ✅ **Transaction 10:** High conversion rate (agent learned exactly what works)
- ✅ Proof: Show decision log over time, metrics trending upward
- ✅ Realistic: Learning plateaus eventually (can't predict everything)

**What fails:**
- ❌ Same rule for transaction 1 and 100
- ❌ No learning mechanism visible
- ❌ Agent makes decisions same way always

**Why this matters:** Learning is the moat. Memory layer compounds. That's the differentiator.

---

### ✅ A8: Payment Failure Recovery Specifically Addressed

**Standard:** Prototype has a concrete angle on payment failures, not ignored.

**What passes:**
- ✅ "Signal tracked: Consumer's card declined → retried with UPI → succeeded"
- ✅ "Pattern identified: This segment retries 40% of time, prefers UPI on retry"
- ✅ "Intervention: Proactively offer UPI/EMI when payment fails"
- ✅ "Impact: Payment recovery is $X annual revenue stream only Razorpay can access"
- ✅ "Why unique: Only Razorpay sees payment failure data"

**What fails:**
- ❌ Payment failures not mentioned
- ❌ Treated as edge case
- ❌ No intervention logic for failures

**Why this matters:** Payment failures are a massive, underserved opportunity. This is your wedge.

---

## BUILDER QUALITIES (B1-B6)

### ✅ B1: Real Merchant Validation

**Standard:** You've talked to merchants, not just theory.

**What passes:**
- ✅ "I talked to 8 merchants. Here's their exact pain: 72% abandonment, $50K/month loss"
- ✅ Can tell 5 different merchant stories (specific, not generic)
- ✅ From their mouth: They described the problem in their own words
- ✅ Evidence of listening: Changed your approach based on feedback
- ✅ Multiple segments: Apparel, electronics, food — different problems

**What fails:**
- ❌ "I read about cart abandonment online"
- ❌ "I think merchants would want this"
- ❌ Talked to 1-2 people max
- ❌ Generic pain points ("too much abandonment")

**Why this matters:** Ideas that sound good fail in practice. Talking to users saves you from building the wrong thing.

---

### ✅ B2: Founder Mentality — Economics & Profitability

**Standard:** Think about money, not just features.

**What passes:**
- ✅ "Merchants will pay $X/month because it's worth $Y in additional revenue"
- ✅ "If we charge 5% of recovered revenue, here's the math: $1M merchant loses $710K/year, recover 5% = $35K, we take 5% = $1.75K/year"
- ✅ "How do we tell merchants about this? Sales motion: Razorpay team pitch, free trial, upsell"
- ✅ "Why they keep paying? Better results every month, compounding learning"
- ✅ "Scale economics: 10 merchants vs. 1000 merchants, unit economics improve"

**What fails:**
- ❌ "I'll build it, worry about business model later"
- ❌ No pricing thought
- ❌ No understanding of merchant ROI
- ❌ "It's free, monetize later"

**Why this matters:** Features that don't make money get killed. Founder thinking keeps you focused.

---

### ✅ B3: Intellectual Honesty — Know What You Don't Know

**Standard:** Acknowledge gaps, don't overconfide.

**What passes:**
- ✅ "This works *if* merchants let us personalize checkout (need to validate)"
- ✅ "Privacy regulation could block us. Here's our mitigation plan."
- ✅ "Data quality could make this fail. Here's how we'd recover."
- ✅ "I'm 70% confident this works, not 100%"
- ✅ "I validated X, still unsure about Y"

**What fails:**
- ❌ "This will definitely work"
- ❌ "No concerns, idea is solid"
- ❌ "I know everything about this space"
- ❌ Defensive when challenged

**Why this matters:** Overconfident founders miss blind spots. Honest founders learn and adapt.

---

### ✅ B4: Execution Speed — Ship Over Perfection

**Standard:** 6-day MVP with clear mocks vs. 6-month perfect system.

**What passes:**
- ✅ "Here's what's real, here's what's mocked: Memory real, payment integration mocked"
- ✅ "Picked 5 signals, not 50, because I need to ship"
- ✅ "Using simple rules, not complex ML, because ML would take too long"
- ✅ "Started building Day 1, not planning for weeks"
- ✅ "Phase 1: MVP. Phase 2: Real integration. Phase 3: ML models."

**What fails:**
- ❌ "I'm building the perfect system"
- ❌ "I need 3 more weeks to get it right"
- ❌ Over-engineering every component
- ❌ "Let me design this perfectly before coding"

**Why this matters:** Speed wins buildathons. Speed wins in startups. Perfect loses.

---

### ✅ B5: Learning Agility — Change Mind When Data Says So

**Standard:** Flexible, not dogmatic.

**What passes:**
- ✅ "I thought X would be the main signal, but data showed Y was bigger. Updated model."
- ✅ "Merchant told me Z, so I changed my approach"
- ✅ "Test showed new consumers are easy to personalize for. Assumption was wrong."
- ✅ "I was wrong about X, here's what I learned"
- ✅ "Every phase, I'm learning and adjusting"

**What fails:**
- ❌ "My original plan was perfect, sticking with it"
- ❌ Defensive when challenged
- ❌ "That data doesn't apply to my case"
- ❌ "I know better"

**Why this matters:** Founders who learn fastest win. Ego kills companies.

---

### ✅ B6: Good Question Asker — Reality Checks Over Validation

**Standard:** Asking hard questions of yourself, not seeking cheerleading.

**What passes:**
- ✅ "What could go wrong?" not "This is good, right?"
- ✅ Challenges own assumptions: "What if merchants don't actually care?"
- ✅ Seeks reality, not validation: "Tell me what's weak about this"
- ✅ Pushes back constructively: "That's a good point, here's how I'd mitigate"
- ✅ Curious, not defensive

**What fails:**
- ❌ Only asks for positive feedback
- ❌ Gets defensive when challenged
- ❌ "Just tell me this is good"
- ❌ Avoids hard conversations

**Why this matters:** Founders who ask hard questions find problems early and fix them.

---

## SCOPE CHECKLIST (C1-C6)

### C1: Consumer Memory System (Real)
- [ ] Stores behavioral signals per consumer
- [ ] Updates in real-time with each transaction
- [ ] Simple but functional (JSON, lightweight DB, or similar)
- [ ] Can retrieve consumer profile in milliseconds

### C2: Agent Decision Logic (Real)
- [ ] 5-7 explicit, explainable decision rules
- [ ] Each rule: Signal → Insight → Action
- [ ] No black-box ML for demo
- [ ] Decision logs showing reasoning

### C3: Demo UI (Real)
- [ ] Simulates checkout flow
- [ ] Shows personalization for 3-5 personas
- [ ] Interactive (user can see agent reasoning)
- [ ] Functional, not beautifully designed

### C4: Test Data (Real)
- [ ] 10-20 realistic consumer personas
- [ ] Messy, overlapping patterns
- [ ] Includes edge cases and contradictions
- [ ] Based on real merchant feedback or research

### C5: Metrics & Validation (Real)
- [ ] Baseline abandonment rate shown (71%)
- [ ] With-agent abandonment rate shown
- [ ] Breakdown of improvement drivers
- [ ] Monetized (revenue impact)

### C6: What's OK to Mock
- [ ] Razorpay payment integration (hardcoded for demo)
- [ ] Real merchant data (use sample merchants)
- [ ] Real review scraping (can use public APIs or hardcoded)
- [ ] Real consumer base (mock with generated profiles)

**Success:** All A1-A8 met, all B1-B6 evident, all C1-C5 real, C6 mocked

---

## PHASE CHECKPOINTS

### After Phase 1: Merchant Validation (Day 1-2)
**Check against:** B1, B2, B3, B6

- [ ] Talked to 5+ merchants (B1)
- [ ] Understand their economics (B2)
- [ ] Acknowledge gaps/risks (B3)
- [ ] Ask hard questions (B6)

**Red flag if missing:** Generic understanding, no merchant voices, no economics

---

### After Phase 2: Memory Design (Day 2-3)
**Check against:** A1, A2, A3, A7, B4

- [ ] Can explain why each signal matters (A1)
- [ ] Test data is messy, realistic (A2)
- [ ] Edge cases documented (A3)
- [ ] Learning mechanism designed (A7)
- [ ] Speed maintained, not over-scoped (B4)

**Red flag if missing:** Black-box design, clean personas, only happy path, over-engineering

---

### After Phase 3: Agent Logic (Day 3-4)
**Check against:** A1, A3, A4, A5, A8, B4

- [ ] Every decision explained (A1)
- [ ] Edge cases handled (A3)
- [ ] Metrics calculated (A4)
- [ ] Razorpay leverage clear (A5)
- [ ] Payment failure recovery included (A8)
- [ ] Simple, not over-engineered (B4)

**Red flag if missing:** Vague decisions, only happy path, no metrics, generic tool

---

### After Phase 4: Demo UI (Day 4-5)
**Check against:** A5, A6, A7, A8

- [ ] Razorpay leverage obvious (A5)
- [ ] Privacy mentioned (A6)
- [ ] Learning progression visible (A7)
- [ ] Payment failure scenario shown (A8)

**Red flag if missing:** Generic tool vibe, zero privacy, static logic, no payment failures

---

### After Phase 5: Full Demo (Day 6)
**Check against:** ALL A1-A8, B1-B6, C1-C6

**Must have:**
- 0 MISSING from A or B sections
- Max 2 WEAK criteria (all others GOOD or STRONG)
- All C sections complete

**Ready to present if:**
- [ ] All 8 mandatory features present
- [ ] All 6 builder qualities evident
- [ ] Scope is complete and realistic
- [ ] Story is compelling
- [ ] No deviations from founder standards

---

## FINAL SCORING

**Prototype quality scored on:**
- **A Score:** 0/8 MISSING = ✅ (all mandatory features present)
- **B Score:** 0/6 MISSING = ✅ (all builder qualities evident)
- **C Score:** 0/8 MISSING = ✅ (all scope complete)
- **Strength Score:** 3+ criteria truly STRONG (not just GOOD)

**Green light given when:** A+B+C all scores perfect, minimum 3 STRONG criteria

---

*This is the bar. Build to this standard, not to what feels easy.*

