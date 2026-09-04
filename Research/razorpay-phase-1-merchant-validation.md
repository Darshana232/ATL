# Razorpay Phase 1: Merchant Validation & Consumer Persona Development
## Days 1-2 Execution Guide

**Project:** Buildathon Track 1 — Payment Failure Recovery  
**Phase:** 1 — Merchant Validation + Persona Research  
**Timeline:** Days 1-2 (8-16 hours)  
**Status:** Ready to Execute  
**Goal:** Understand real merchant pain, validate assumptions, create realistic consumer personas

---

## PHASE 1 OVERVIEW

### What You're Trying to Answer

1. **Is payment failure recovery a real problem for merchants?**
   - How much revenue do they actually lose?
   - What's their current retry rate?
   - How much would they pay to solve it?

2. **What payment methods do their consumers prefer?**
   - Which methods work best?
   - Which fail most often?
   - What's the consumer demographic?

3. **What does realistic consumer behavior look like?**
   - How do consumers react to payment failure?
   - Do they retry? With what method?
   - What patterns exist?

4. **What should our agent prioritize?**
   - Which methods to recommend first?
   - Which segments matter most?
   - What edge cases matter?

### Success Criteria for Phase 1

✅ 5-8 merchant interviews completed  
✅ Specific, real merchant stories captured (not generic)  
✅ Economics validated (revenue loss numbers concrete)  
✅ 10-15 realistic consumer personas created  
✅ Personas are MESSY (overlapping patterns, contradictions)  
✅ All founder criteria B1, B2, B3, B6 met  

---

## STEP 1: PREPARE INTERVIEW SCRIPT (30 minutes)

### Before You Call Anyone

Read through this script. Adjust for your tone. Practice once.

**Goal:** Get merchant stories that are specific, measurable, real.

---

## MERCHANT INTERVIEW SCRIPT

### **Opening (1 minute)**

"Hi [Name]. Thanks for taking the call. I'm working on a payment failure recovery project for Razorpay's buildathon. I'd love to understand your experience with payment failures and consumer behavior. This should take about 15-20 minutes. Is that okay?"

*[Wait for yes, start recording notes]*

---

### **SECTION A: Understanding Their Payment Failures (5 minutes)**

#### Question A1: Payment Failure Volume
**"How many payment transactions do you process monthly? And roughly what percentage fail on the first attempt?"**

*Listen for:*
- Specific numbers (e.g., "500 transactions/month, 5% fail = 25 failures/month")
- If vague, probe: "Would you guess 5%, 10%, or higher?"
- If unsure, say: "Industry average is 5-10%. Does that sound right for you?"

*Record:*
```
Merchant: [Name]
Monthly transactions: ___
Failure rate: ___% (= ___ failures/month)
Failure pattern: [Describe]
```

---

#### Question A2: Revenue Loss
**"Of those failures, how many consumers retry versus abandon completely? And roughly how much revenue do you lose annually to payment failures?"**

*Listen for:*
- Retry behavior ("Maybe 1 in 10", "I honestly don't know", "Some percentage")
- Revenue impact ("Could be $10K/year", "Hard to calculate", "Probably $50K+")
- Frustration signal (is this a real pain point?)

*Record:*
```
Retry rate: __% of consumers
Annual revenue lost to failures: $___K
Confidence: High / Medium / Low (they know this or guessing)
Pain level: [1-10, where 10 is "this is killing us"]
```

---

#### Question A3: Current Recovery
**"Do you currently do anything to recover from payment failures? (Email, SMS, retry prompts, etc.)"**

*Listen for:*
- What they're already doing
- How effective they think it is
- What they've tried that didn't work
- Why they haven't solved it yet

*Record:*
```
Current recovery method: [None / Email / SMS / Other: ___]
Effectiveness: Low / Medium / High
Why not better: [Barriers to improvement]
```

---

### **SECTION B: Payment Methods & Consumer Preferences (5 minutes)**

#### Question B1: Payment Method Mix
**"What payment methods do you offer? And what's the typical split between them?"**

*Listen for:*
- Methods offered (Card, UPI, Wallet, EMI, COD)
- Which consumers use most
- Which are growing/declining
- Geographic split (if multi-region)

*Record:*
```
Payment methods offered:
├─ Card: __% of transactions
├─ UPI: __% of transactions
├─ EMI: __% of transactions
├─ Wallet: __% of transactions
├─ COD: __% of transactions
└─ Other: __% of transactions

Regional variation: [Notes]
```

---

#### Question B2: Method Reliability
**"In your experience, which payment methods fail most often and which are most reliable?"**

*Listen for:*
- Specific failure patterns ("Cards fail on international", "UPI is super reliable")
- Issuer patterns if they know ("HDFC cards fail more than ICICI")
- Merchant category patterns ("Apparel has higher card failure")
- Device/network patterns ("Mobile network issues cause timeouts")

*Record:*
```
Most reliable: [Method #1, Method #2]
Fail most often: [Method #1]
Known patterns: [Specific failure behaviors]
```

---

#### Question B3: Consumer Segment
**"Describe your typical customer. What's their demographic, location, device, buying pattern?"**

*Listen for:*
- Age/income/segment (Tier-1 metro vs. Tier-2/3)
- Device (mobile first)
- Payment preference
- Buying triggers (impulse vs. deliberate)
- Trust level (high vs. skeptical of digital payments)

*Record:*
```
Typical customer:
├─ Age: ___
├─ Location: [Tier-1 / Tier-2 / Tier-3 / Mixed]
├─ Device: [Desktop / Mobile / Both]
├─ Income: [Low / Mid / High]
├─ Payment preference: [Card / UPI / EMI / COD / Mixed]
├─ Trust level: [Low (wants COD) / Medium / High (comfort with digital)]
└─ Buying pattern: [Impulse / Deliberate / Seasonal]
```

---

### **SECTION C: Payment Failure Behavior (5 minutes)**

#### Question C1: Consumer Reaction to Failure
**"When a payment fails for a consumer, what do you think they do? Do they reach out to support, retry on their own, or just abandon?"**

*Listen for:*
- Specific behaviors they've observed
- Complaints they receive
- Whether they see retry attempts
- Whether they follow up

*Record:*
```
When payment fails:
├─ Retry immediately: [Yes/No/Some] ___% 
├─ Try different method: [Yes/No/Some] ___% 
├─ Contact support: [Yes/No] ___% 
├─ Abandon completely: ___% 
└─ Notes: [Specific stories]

Support tickets related to payment failure: ___/month (rough)
```

---

#### Question C2: Specific Consumer Stories
**"Can you tell me about a specific consumer who had a payment failure? What happened? Did they retry? What method?"**

*Listen for:*
- Concrete example (not hypothetical)
- Step-by-step: "They tried card, failed. Then tried UPI, succeeded."
- Emotional reaction ("Frustrated", "Gave up", "Tried everything")
- Outcome ("Completed later", "Lost sale", "They complain but no solution")

*Record:* (Get 2-3 specific stories)
```
Story #1:
├─ Scenario: [What they bought, amount, device]
├─ Failure: [Card declined / Timeout / Issuer block]
├─ Reaction: [Retry / Different method / Abandoned]
├─ Outcome: [Success / Loss / Complaint]
└─ Learning: [What would have helped?]
```

---

#### Question C3: Would They Change Payment Methods on Recommendation?
**"If a consumer's card failed, and you could instantly tell them 'Try UPI instead — you've succeeded with UPI before' — would they do it?"**

*Listen for:*
- Confidence in their answer
- Skepticism ("They might not trust it")
- Enthusiasm ("Yes, absolutely")
- Conditions ("Only if they're on mobile", "Only if they really want the product")

*Record:*
```
Would consumer retry on recommendation: [Yes / Maybe / No]
Confidence: [High / Medium / Low]
What would increase likelihood:
├─ Show they've succeeded before with method
├─ Show method reliability ("95% success rate")
├─ Show urgency or incentive
└─ Other: [___]
```

---

### **SECTION D: Willingness to Use AI Agent (3 minutes)**

#### Question D1: Would You Pay for This?
**"If we built an AI agent that intelligently recommends payment methods to consumers when their payment fails, improving your recovery rate from 10-20% to 40%+, what would you pay for it? Monthly subscription? Share of recovered revenue?"**

*Listen for:*
- Specific number or range
- Hesitation (is ROI not obvious?)
- Enthusiasm ("Yes! How much?")
- Questions ("What if the recommendation is wrong?")

*Record:*
```
Willingness to pay: $ ___ /month or ___ % of recovered revenue
Confidence: [High / Medium / Low]
Questions/concerns: [Capture their hesitations]
Enthusiasm level: [1-10]
```

---

#### Question D2: Critical Questions
**"What could go wrong with an AI recommendation? What would make you nervous?"**

*Listen for:*
- Privacy concerns ("Is the consumer okay with this?")
- Accuracy concerns ("What if recommendation is wrong?")
- Brand concerns ("Would this look desperate?")
- Technical concerns ("What if the recommendation doesn't work?")

*Record:*
```
Concerns about AI recommendation:
├─ Privacy: [___]
├─ Accuracy: [___]
├─ Brand: [___]
├─ Technical: [___]
└─ Other: [___]
```

---

### **SECTION E: Closing (1 minute)**

**"Is there anything else about payment failures or consumer behavior you think I should know?"**

*Listen for:*
- Final insights they think are important
- Things they wish they could measure
- Specific merchant category insights

*Record:*
```
Final insights: [___]
```

---

**Thank you so much. This really helps. We'll definitely follow up when we have something to show you.**

---

## STEP 2: CONDUCT INTERVIEWS (2-4 hours)

### Who to Interview

**Target:** 5-8 merchants across 2-3 categories

```
IDEAL MERCHANT MIX:
├─ 2-3 from Apparel/Fashion (high cart abandonment)
├─ 2-3 from Electronics (high transaction value)
├─ 1-2 from Other (Food/Grocery, SaaS, Marketplace)
└─ Mix of: Small ($500K/year) and Medium ($2-10M/year)
```

**Where to find them:**
- Your brother's network (if he has merchant contacts)
- LinkedIn (search "Razorpay" + merchant)
- Razorpay website (merchants using Razorpay)
- Your personal network

**Call approach:**
- Email or WhatsApp first: "Hey, working on a Razorpay buildathon project. Would love 15-20 min to understand your payment challenges."
- Most will say yes if you're working on something that might help them
- If hesitant: "It's research for a student project. Won't sell you anything, just learning."

### Interview Best Practices

✅ **Record notes in real-time** (not memory)  
✅ **Ask follow-up questions** ("Tell me more about that")  
✅ **Listen for contradiction** ("You said 10%, but earlier said some retry — which is it?")  
✅ **Get specific numbers** (not "many", "most", "lots")  
✅ **Capture exact quotes** (use their words in your summary)  
✅ **Thank them genuinely** (they're helping your project)  

❌ **Don't pitch your idea** (You're learning, not selling)  
❌ **Don't ask leading questions** ("Right? So you definitely lose $50K?")  
❌ **Don't argue with them** (If they say "Retry rate is 50%", write it down)  
❌ **Don't interview strangers only** (Mix warm + cold intros)  

---

## STEP 3: SYNTHESIZE MERCHANT INSIGHTS (1 hour)

After all interviews, create a summary:

### Merchant Insights Summary

```markdown
## Interview Summary (5-8 merchants)

### Key Statistics (Aggregate)
- Average payment failure rate: ___%
- Average retry rate: ___%
- Average annual revenue loss: $___K
- Willingness to pay: $__ - $__ /month or _% of recovered

### Common Patterns
1. [Most common pain point across merchants]
2. [Most common consumer behavior]
3. [Most needed solution feature]

### Disagreements
- [On this topic, merchant A said X, merchant B said Y]
- [Why might they disagree?]

### Red Flags / Surprises
- [Anything unexpected?]
- [Assumptions we got wrong?]

### Key Quotes (Use Exact Words)
- "Quote from merchant about their pain"
- "Quote from merchant about consumer behavior"
- "Quote from merchant about willingness to pay"

### Action Items for Agent Design
- [Based on interviews, what should agent prioritize?]
- [Which payment methods matter most?]
- [Which segments should we optimize for?]
```

---

## STEP 4: CREATE REALISTIC CONSUMER PERSONAS (2 hours)

### Persona Development Process

**Important:** Personas must be MESSY, OVERLAPPING, CONTRADICTORY — like real consumers.

### Template: Consumer Persona

For each persona, create:

```markdown
## Persona: [Name]

### Demographics
- Age: ___
- Location: [Tier-1 / Tier-2 / Tier-3]
- Income: [Low / Mid / High]
- Device: [Mobile / Desktop / Both]

### Payment Behavior
- Preferred method: [Card / UPI / EMI / Wallet / COD]
- Success rate by method:
  ├─ Card: ___%
  ├─ UPI: ___%
  ├─ EMI: ___%
  └─ Other: ___%
- Retry behavior: [Never retries / Sometimes retries / Always retries]

### Psychological Profile
- Trust level: [Low (prefers COD) / Medium / High (comfort with digital)]
- Impulse buyer: [Yes / No / Depends]
- Review-reader: [Always / Sometimes / Never]
- Price-sensitive: [Very / Somewhat / Not much]

### Specific Pattern (The Contradiction!)
- Usually: [Behavior pattern 1]
- But sometimes: [Contradictory behavior 2]
- Example story: [Specific transaction showing this]

### Payment Failure History
- Times failed: __
- First failure reaction: [Abandoned / Retried same / Tried different method]
- Second failure reaction: [Different from first?]
- Pattern: [Does this consumer retry on different method?]

### Why This Persona Matters
- This consumer represents __% of typical merchant's base
- Payment failures hit this segment [hardest / mildest / unpredictably]
- Agent should [recommend UPI / offer incentive / show social proof]
```

---

### 10-15 Realistic Personas to Create

Based on merchant interviews, create personas like:

```
PERSONA #1: Ravi (Tier-2, Card User, High Retry)
├─ Age: 28, Bangalore
├─ Device: Mobile
├─ Usually buys with: Card
├─ BUT: When card fails, always retries with UPI
├─ Pattern: Card + UPI combo user
└─ Why: "Card is easier, UPI is backup"

PERSONA #2: Priya (Tier-3, UPI User, Never Retries)
├─ Age: 24, Small town
├─ Device: Mobile only
├─ Usually buys with: UPI
├─ BUT: If UPI fails once, abandons completely
├─ Pattern: Single-method loyalty, high abandon on failure
└─ Why: "UPI is all I know. If it doesn't work, maybe it's not for me"

PERSONA #3: Amit (Tier-1, All-Methods User, Impatient)
├─ Age: 35, Delhi
├─ Device: Desktop
├─ Usually buys with: Card
├─ BUT: Tries different method if first fails (card → UPI → EMI in 30s)
├─ Pattern: Friction-hater, will pay any way if easy
└─ Why: "Just let me pay. I don't care how"

PERSONA #4: Neha (Tier-2, Card User, Low Trust)
├─ Age: 22, Mumbai
├─ Device: Mobile
├─ Usually buys with: Card (sometimes)
├─ BUT: When card fails, doesn't retry — calls support first
├─ Pattern: High trust requirement, wants human reassurance
└─ Why: "If card didn't work, maybe something is wrong. Let me talk to someone"

PERSONA #5: Rahul (Tier-2, Mixed Methods, Deal Hunter)
├─ Age: 31, Pune
├─ Device: Both
├─ Usually buys with: EMI (gets 12 months to pay)
├─ BUT: Will try card if there's a discount
├─ Pattern: Method changes based on offer/deal
└─ Why: "I buy based on what's the best deal at that moment"

... and 10 more across different patterns
```

### Criteria for Good Personas

✅ **Messy:** Not "price-seeker" or "review-reader". Real people are both sometimes.  
✅ **Specific:** "Tier-2 mobile user from Delhi" not "Indian e-commerce consumer"  
✅ **Contradictory:** "Usually X but sometimes Y" with a reason  
✅ **Behavioral Data:** Payment method preference, success rate, retry likelihood  
✅ **Story-based:** Can tell a specific transaction story for each  
✅ **Diverse:** Represent different segments, ages, locations, behaviors  
✅ **Research-backed:** Based on actual merchant interviews, not imagination  

---

## STEP 5: VALIDATE AGAINST FOUNDER CRITERIA (30 minutes)

### Check: Did we meet B1, B2, B3, B6?

**B1: Real Merchant Validation**
- [ ] Talked to 5+ merchants ✅
- [ ] Can tell 5 different merchant stories (specific, not generic)
- [ ] Merchant quotes captured (exact words)
- [ ] Evidence of listening (changed approach based on feedback)

**B2: Founder Mentality — Economics**
- [ ] Understand merchant ROI ("$50K lost, we recover $X")
- [ ] Can defend price point ("We charge $500/month because recovery is $15K/year")
- [ ] Know sales motion (who buys, why, how much)
- [ ] Think about unit economics (10 merchants vs. 1000 merchants)

**B3: Intellectual Honesty — Know Gaps**
- [ ] Document assumptions still unproven
- [ ] Note risks ("Payment failure recovery might not work if merchants don't offer multiple methods")
- [ ] Identify data gaps ("We need to know exact retry patterns")
- [ ] Say what we're unsure about ("Uncertain if incentives help or hurt")

**B6: Good Questions**
- [ ] Asked hard questions during interviews ("What could go wrong?")
- [ ] Captured merchant concerns (not just enthusiasm)
- [ ] Identified contradictions ("You said low retry but later said high?")
- [ ] Questioned own assumptions ("Is $15K ROI realistic?")

---

## STEP 6: DOCUMENT PHASE 1 FINDINGS (30 minutes)

Create a summary document with:

### Phase 1 Findings Summary

```markdown
# Phase 1: Merchant Validation — Findings

## Interviews Conducted
- 5-8 merchants
- Across [Apparel, Electronics, Other]
- Revenue mix: [Small to large]

## Key Findings

### 1. Payment Failures Are Real
- Average failure rate: __% (range: _% to _%)
- Average annual revenue loss: $__K (range: $K to $K)
- Merchant pain level: [High / Medium] (1-10 rating: __)

### 2. Current Recovery Rate Is Low
- Baseline retry rate: __% (range: _% to _%)
- Merchants don't track recovery
- No systematic solution in place

### 3. Consumer Behavior Patterns
- [Pattern 1]: __% of consumers exhibit this
- [Pattern 2]: __% of consumers exhibit this
- [Pattern 3]: __% of consumers exhibit this

### 4. Willingness to Pay
- Average: $__ /month or __% of recovered revenue
- Confidence: High / Medium / Low
- Enthusiasm: Merchants want this solution [Yes / Moderate / Unclear]

### 5. Key Concerns
- [Concern 1]: Privacy, transparency, merchant control
- [Concern 2]: What if recommendation is wrong?
- [Concern 3]: What if consumer feels pushed?

## Consumer Personas Created
- 10-15 realistic personas
- Based on merchant interviews
- Each with: Demographics, behavior, payment patterns, contradictions

## Next Steps for Agent Design
1. [Based on findings, priority #1]
2. [Based on findings, priority #2]
3. [Based on findings, priority #3]

## Assumptions Validated
- ✅ [Assumption we confirmed]
- ❌ [Assumption we disproved]
- ❓ [Assumption still unclear]

## Founder Criteria Check
- B1: Real Merchant Validation ✅
- B2: Founder Mentality ✅
- B3: Intellectual Honesty ✅
- B6: Good Questions ✅
```

---

## TEMPLATES FOR YOU TO USE

### Template 1: Interview Notes (Copy for each merchant)

```
INTERVIEW #1: [Merchant Name]
Date: [Date]
Duration: [Minutes]
Category: [Apparel/Electronics/Other]
Annual Revenue: $[Rough estimate]

A. PAYMENT FAILURES
└─ Monthly transactions: ___
└─ Failure rate: ___%
└─ Annual revenue lost: $___K
└─ Retry rate: ___%
└─ Current recovery: [None/Email/SMS/Other]

B. PAYMENT METHODS
└─ Methods offered: Card (___%), UPI (___%), EMI (___%), Other
└─ Most reliable: [Method]
└─ Fails most: [Method]
└─ Consumer segment: [Describe]

C. CONSUMER BEHAVIOR
└─ When payment fails: [Describes retry behavior]
└─ Specific story #1: [___]
└─ Specific story #2: [___]
└─ Would retry on recommendation: [Yes/Maybe/No]

D. MONETIZATION
└─ Willingness to pay: $___/month or ___%
└─ Concerns: [List]

E. KEY QUOTES
└─ "[Quote 1]"
└─ "[Quote 2]"
└─ "[Quote 3]"

F. NOTES
└─ [Any other insights]
```

### Template 2: Persona Canvas

```
PERSONA: [Name]

Basic Info:
├─ Age: ___
├─ Location: ___
├─ Income Level: ___
└─ Device: ___

Payment Behavior:
├─ Preferred: ___
├─ Card: __% success
├─ UPI: __% success
├─ EMI: __% success
└─ Retry behavior: ___

Contradiction (The Real Insight):
├─ Usually: [Pattern 1]
├─ But: [Pattern 2]
└─ Example: [Specific transaction]

Payment Failure Likelihood:
├─ Failure scenario: [When/How]
├─ Likely reaction: [Retry/Abandon/Switch method]
└─ Agent recommendation: [What should agent suggest?]

Why This Persona Matters:
└─ Represents __% of typical merchant base
```

---

## RED FLAGS & WHAT TO DO

### Red Flag #1: Merchants Say "I Don't Know"
**Problem:** They can't give you numbers  
**Action:** Probe deeper — "Would you guess 5%, 10%, or 20%? Is it closer to $10K or $100K loss?"  
**Record:** Note their confidence level ("They're guessing")

### Red Flag #2: All Merchants Same Answer
**Problem:** Answers are too consistent (suspicious)  
**Action:** Question if you're leading them ("Am I asking this right?")  
**Record:** Note that consistency, could mean you're biasing

### Red Flag #3: Merchants Enthusiastic But Vague
**Problem:** "Yeah this is a problem!" but can't quantify  
**Action:** Push on specifics — "$10K or $50K impact? Monthly or annual?"  
**Record:** "Enthusiastic but couldn't quantify"

### Red Flag #4: No One Retry
**Problem:** Merchant says "Nobody retries, they just abandon"  
**Action:** Ask "Have you ever tried to make it easier for them to retry?"  
**Record:** Could mean (a) real problem or (b) merchant never gave them option

---

## SUCCESS CHECKLIST (End of Days 1-2)

Before moving to Phase 2, verify:

### Interviews
- [ ] 5-8 merchants interviewed
- [ ] All interviews documented (notes, quotes, numbers)
- [ ] Mix of categories (apparel, electronics, other)
- [ ] Mix of sizes ($500K to $10M+ revenue)

### Merchant Insights
- [ ] Payment failure rates documented (specific numbers)
- [ ] Revenue impact calculated (specific $K numbers)
- [ ] Retry rates noted (specific %s)
- [ ] Willingness to pay understood ($X/month or X%)
- [ ] Key concerns captured (privacy, accuracy, brand)

### Consumer Personas
- [ ] 10-15 personas created
- [ ] Each persona is MESSY (contradictions noted)
- [ ] Each persona has payment behavior documented
- [ ] Each persona has specific payment failure pattern
- [ ] Personas are DIVERSE (ages, locations, behaviors vary)
- [ ] Personas are RESEARCH-BACKED (based on interviews)

### Founder Criteria
- [ ] B1: Can tell 5 different merchant stories (specific, not generic)
- [ ] B2: Economics understood ($X lost, willing to pay $Y)
- [ ] B3: Gaps and assumptions documented
- [ ] B6: Hard questions asked and captured

### Documentation
- [ ] All interview notes saved
- [ ] Merchant insights summary written
- [ ] All 10-15 personas documented
- [ ] Phase 1 findings summary created
- [ ] Ready to hand to co-founder for review

---

## WHEN YOU'RE DONE

**Deliverables to hand over:**

1. Interview notes (5-8 documents)
2. Merchant insights summary (1 document)
3. Consumer personas (10-15 documents or 1 file with all)
4. Phase 1 findings summary (1 document)
5. Economics calculation (spreadsheet or markdown)

**Scorecard updates:**
- B1: ✅ Real Merchant Validation
- B2: ✅ Founder Mentality
- B3: ✅ Intellectual Honesty
- B6: ✅ Good Questions

**Ready for Phase 2:** Memory Layer Design (Days 2-3)

---

## QUICK START CHECKLIST

- [ ] Read this entire guide
- [ ] Prepare interview script (customize for your style)
- [ ] Identify 5-8 merchants to interview
- [ ] Send outreach emails/messages
- [ ] Schedule interviews (aim for 15-20 min each)
- [ ] Conduct interviews (take detailed notes)
- [ ] Synthesize merchant insights (1-2 hours)
- [ ] Create 10-15 realistic personas
- [ ] Validate against founder criteria (B1, B2, B3, B6)
- [ ] Document all findings
- [ ] Prepare for Phase 2

---

**Good luck. Get real merchant stories. Build realistic personas. Show founder thinking.**

**See you on Day 3 for Phase 2 review.**

