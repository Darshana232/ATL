# External APIs — evaluation and tiering

Per `Claude/CLAUDE.md` §5. Every candidate external service, classified:

- **Tier A** — real and usable in the MVP today
- **Tier B** — available but needs credentials or account approval
- **Tier C** — useful only as a simulated/mocked integration
- **Tier D** — not worth integrating

**Last verified:** 2026-09-04 (by direct HTTP call, not by reading a list).

---

## Tier A — integrate

### Razorpay REST API, test mode
`https://api.razorpay.com/v1` · auth: test key + secret · **not yet obtained**

Orders, Payments, Payment Links (incl. UPI), Refunds, webhooks. Test mode uses
separate keys, moves no real money, accepts designated test UPI IDs, and works
without full KYC. This is our one genuine payment integration
(`RazorpayTestProvider`, Phase 7).

### Razorpay IFSC API
`https://ifsc.razorpay.com/{IFSC}` · **no auth** · verified 200

```json
{ "BANK": "HDFC Bank", "BANKCODE": "HDFC", "BRANCH": "TULSIANI CHMBRS - NARIMAN PT",
  "CITY": "GREATER MUMBAI", "STATE": "MAHARASHTRA", "MICR": "400240003",
  "UPI": true, "IMPS": true, "NEFT": true, "RTGS": true, "SWIFT": "HDFCINBB" }
```

Operated by Razorpay, keyless, and returns a **per-branch `UPI` eligibility
flag**. Gives us real Indian bank and VPA-handle data instead of invented
strings.

**Where we may call it — this distinction is the point:**

| Use | Allowed | Reasoning |
|---|---|---|
| Seed-time fixture generation, result committed as JSON | ✅ | No runtime dependency |
| Mandate creation (Phase 3): validate IFSC, display bank, record UPI support | ✅ with a 2s timeout and graceful degradation | Cold path, user-facing, failure is tolerable and visible |
| Anywhere inside the authorization path | ❌ **never** | A compliance verdict must not depend on a third party's uptime. If they are down, do we block every payment or allow every payment? Both answers are wrong. |

### Anthropic API
`https://api.anthropic.com` · auth: API key · **not yet obtained**

Claude plus tool calling for the agent runtime (Phase 8). First-class
TypeScript SDK.

---

## Tier B — needs approval, not feasible for the buildathon

### API Setu (Government of India)
`https://www.apisetu.gov.in/` · organizational onboarding required

Government KYC, business, education and employment APIs. This is genuinely the
**correct production answer** for merchant KYC and for a real Know-Your-Agent
registry. Cite it in the pitch as the production path; do not attempt to
integrate it now.

### data.gov.in
`apiKey`, free registration. No current use — we have no need for open
government datasets.

---

## Tier C — simulated instead

| Service | Why we simulate rather than integrate |
|---|---|
| NPCI UAP / UPI Reserve Pay mandate rail | No public specification exists. UAP is still in development and needs RBI approval. Our mandate model is our own design, adapter-isolated and labelled. |
| Fraud risk scoring ("AFRI") | Does not exist — it is a proposal document in `Research/`. `MockRiskProvider`. |
| Product catalog | Seeded Indian grocery/food fixtures with real ISO 18245 MCCs. See rejection of DummyJSON below. |
| Notifications (user alerts on block/flag) | `MockNotificationProvider` writing to the audit trail. Sending real SMS/WhatsApp adds cost, PII exposure and zero demo value. |

---

## Tier D — rejected, with reasons

| Service | Status when tested | Why rejected |
|---|---|---|
| **DummyJSON** | works, no auth | USD prices, US consumer goods (mascara, phones), and **no MCC**. Our category rules key on ISO 18245 MCCs, not product titles. A hand-seeded Indian grocery catalog is *more* realistic and adds no network dependency. |
| **FakeStoreAPI** | works, no auth | Same reasons. Backpacks in USD. |
| **PostalPinCode** | works, no auth | Address realism we do not need, and ingesting more PII-shaped data fights our own data-minimisation control. |
| **Indian Pincode** | **HTTP 000 — no response** | Dead. |
| **Indian Mandi Prices** | **returns HTML, not JSON** | Listed as a keyless JSON API; it serves a docs page. |
| **exchangerate.host** | **now requires a key** (`error 101 missing_access_key`) despite being listed `Auth: No` | Also irrelevant: we are INR-only and must never convert currency in an audit record. |
| Chomp, Best Buy, eBay, Flipkart Marketplace, Etsy, WooCommerce | — | Real catalogs, but all need merchant accounts or OAuth, and none supply the MCC + INR + mandate context our rules need. |
| Everything else in `public-apis` | — | Sports odds, social media, memes, weather. Irrelevant. |

---

## On `public-apis/public-apis` as a source

**Repo:** `github.com/public-apis/public-apis` · **MIT** · ~340k stars ·
1,748 entries across 50 categories.

It is a *directory*, not code, so there is no supply-chain risk from the repo
itself. The risk lives in the listed services: no SLA, no data-processing
agreement, and unknown data handling — so no PII may ever be sent to one of
them (a DPDP problem as well as a security one).

**Its entries go stale.** Of seven I tested, **three were broken or wrong**:
one dead, one serving HTML instead of JSON, one silently now requiring an API
key while still listed as keyless. Treat it as a discovery index and verify
every entry by calling it before designing anything around it.

Useful for discovery. Never a dependency.
