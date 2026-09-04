# IDEA #2 India MVP: Full Build & Execution Plan
## Week-by-Week Sprint Breakdown, Tech Stack, Deliverables, Testing

**Status:** Ready for Engineering Kickoff | **Duration:** 8 weeks | **Team:** 3.5 FTE | **Target:** Buildathon-Ready + Live Pilot Data

---

## PART 1: PROJECT STRUCTURE & TECH STACK

### Recommended Tech Stack (Leveraging Razorpay Infrastructure)

#### Backend
- **Language:** Python 3.11+ (Razorpay standard)
- **Web Framework:** FastAPI (async, modern, production-ready)
- **Database:** PostgreSQL 15+ (append-only audit logs, immutable constraints)
- **Message Queue:** Kafka or Redis Streams (real-time transaction ingestion)
- **Search/Indexing:** Elasticsearch (audit trail full-text search for regulator queries)
- **Cache:** Redis (compliance rule evaluation cache, rate limiting)

#### Data & ML
- **Data Pipeline:** Apache Spark (batch processing audit logs)
- **Data Warehouse:** BigQuery or Redshift (historical audit analysis)
- **Report Generation:** Python + Jinja2 templates (PDF/JSON compliance reports)
- **Hash/Crypto:** Python cryptography library (SHA-256 hash chain)

#### Frontend
- **Dashboard:** React 18+ (TypeScript)
- **UI Component Lib:** Material-UI or shadcn/ui
- **State Management:** TanStack Query + Zustand
- **Charts:** Recharts (for audit trail visualizations)
- **Report Viewer:** React-PDF + PDF.js

#### DevOps & Infrastructure
- **Containerization:** Docker
- **Orchestration:** Kubernetes (if Razorpay uses it) or Docker Compose (for MVP)
- **CI/CD:** GitHub Actions or GitLab CI
- **Cloud:** AWS/GCP (Razorpay's preferred cloud)
- **Monitoring:** Prometheus + Grafana (observability)
- **Logging:** ELK Stack or CloudWatch (audit log retention verification)

#### Testing
- **Unit Tests:** pytest
- **Integration Tests:** pytest + testcontainers (real PostgreSQL for testing)
- **API Tests:** FastAPI TestClient
- **E2E Tests:** Playwright or Cypress
- **Load Testing:** Locust (simulate 1M+ transactions)
- **Data Validation:** Great Expectations (audit data quality)

---

### Repository Structure

```
razorpay-atl-india/
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py (FastAPI app initialization)
│   │   ├── config.py (environment config)
│   │   ├── models/ (SQLAlchemy ORM models)
│   │   │   ├── audit_log.py
│   │   │   ├── mandate.py
│   │   │   ├── agent_registry.py
│   │   │   └── compliance_rule.py
│   │   ├── schemas/ (Pydantic request/response schemas)
│   │   │   ├── audit_trail.py
│   │   │   ├── compliance_report.py
│   │   │   └── mandate.py
│   │   ├── routes/ (API endpoints)
│   │   │   ├── audit_trail.py (GET /audit-logs, POST /audit-logs)
│   │   │   ├── compliance.py (GET /reports/free-ai, /reports/str, /reports/dpdp)
│   │   │   ├── mandates.py (GET/POST /mandates)
│   │   │   └── health.py (GET /health)
│   │   ├── services/ (business logic)
│   │   │   ├── audit_trail_service.py (logging, hash chain)
│   │   │   ├── compliance_service.py (rule evaluation)
│   │   │   ├── report_service.py (report generation)
│   │   │   └── fraud_signal_service.py (AFRI integration)
│   │   ├── rules/ (mandate breach detection)
│   │   │   ├── mandate_cap_check.py
│   │   │   ├── merchant_whitelist_check.py
│   │   │   ├── category_blacklist_check.py
│   │   │   ├── time_window_check.py
│   │   │   ├── mandate_expiry_check.py
│   │   │   └── velocity_check.py
│   │   ├── templates/ (report generators)
│   │   │   ├── free_ai_report.jinja2
│   │   │   ├── str_draft.jinja2
│   │   │   └── dpdp_register.jinja2
│   │   ├── utils/ (helpers)
│   │   │   ├── hash_chain.py (SHA-256, tamper detection)
│   │   │   ├── date_utils.py
│   │   │   ├── masking.py (PII masking for DPDP)
│   │   │   └── validators.py (data validation)
│   │   ├── database.py (SQLAlchemy connection, migrations)
│   │   ├── events.py (Kafka/Redis listeners for real-time data)
│   │   └── middleware/ (logging, rate limiting, CORS)
│   ├── tests/
│   │   ├── unit/ (test business logic in isolation)
│   │   │   ├── test_hash_chain.py
│   │   │   ├── test_mandate_cap_check.py
│   │   │   ├── test_compliance_rules.py
│   │   │   └── test_report_generation.py
│   │   ├── integration/ (test with real DB)
│   │   │   ├── test_audit_trail_logging.py
│   │   │   ├── test_api_endpoints.py
│   │   │   └── test_compliance_reports.py
│   │   ├── fixtures/ (test data, sample mandates, transactions)
│   │   │   ├── sample_mandates.json
│   │   │   ├── sample_transactions.json
│   │   │   └── edge_cases.json
│   │   └── e2e/ (end-to-end workflow tests)
│   ├── migrations/ (Alembic DB migrations)
│   ├── Dockerfile
│   ├── requirements.txt (Python dependencies)
│   ├── .env.example (environment template)
│   └── README.md
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── AuditTrailDashboard.tsx (main dashboard)
│   │   │   ├── TransactionDetail.tsx (single transaction audit record)
│   │   │   ├── MandateManager.tsx (create/edit mandates)
│   │   │   ├── ComplianceReportViewer.tsx (display reports)
│   │   │   ├── RuleVerdictDisplay.tsx (Signal → Rule → Verdict)
│   │   │   └── CertificationBadge.tsx
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx
│   │   │   ├── AuditLogs.tsx
│   │   │   ├── ComplianceReports.tsx
│   │   │   ├── Mandates.tsx
│   │   │   └── Settings.tsx
│   │   ├── hooks/ (custom React hooks)
│   │   │   ├── useAuditTrail.ts (fetch/cache audit logs)
│   │   │   ├── useComplianceReports.ts
│   │   │   └── useMandates.ts
│   │   ├── services/ (API client)
│   │   │   └── api.ts (axios instance, endpoints)
│   │   ├── store/ (Zustand state)
│   │   │   └── store.ts
│   │   ├── utils/ (formatters, parsers)
│   │   │   ├── formatters.ts
│   │   │   └── validators.ts
│   │   └── App.tsx
│   ├── public/
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── README.md
├── data/
│   ├── schemas/ (JSON schemas, examples)
│   │   ├── audit_record_schema.json
│   │   ├── mandate_schema.json
│   │   └── compliance_report_schema.json
│   ├── fixtures/ (sample data for testing)
│   │   ├── merchants.csv (Bigbasket, Vi, Zomato)
│   │   ├── mandates.csv (test mandates)
│   │   ├── transactions.csv (sample UPI transactions)
│   │   └── edge_cases.csv (edge cases: expired, velocity, etc.)
│   └── README.md
├── docs/
│   ├── ARCHITECTURE.md (system design)
│   ├── API_REFERENCE.md (endpoint docs)
│   ├── DATABASE_SCHEMA.md (audit trail table design)
│   ├── COMPLIANCE_FRAMEWORK.md (FREE-AI, DPDP, PMLA mapping)
│   └── DEPLOYMENT.md (how to deploy to production)
├── docker-compose.yml (local development: PostgreSQL, Redis, Kafka, frontend, backend)
├── .github/
│   └── workflows/
│       ├── test.yml (run tests on every PR)
│       ├── build.yml (Docker build)
│       └── deploy.yml (deploy to staging/prod)
├── .gitignore
├── README.md (project overview)
└── SETUP.md (quick start guide)
```

---

## PART 2: WEEK-BY-WEEK SPRINT BREAKDOWN

### **WEEK 1-2: Foundation & Data Ingestion**

**Goal:** Build immutable audit trail infrastructure; connect to Razorpay payment data

#### Week 1 Tasks

**Backend (1 engineer):**
- [ ] Set up FastAPI project structure, dependency injection, config management
- [ ] Define SQLAlchemy ORM models:
  - `AuditLog` (append-only, no updates/deletes)
  - `Mandate` (cap, allowlist, blacklist, time window, expiry)
  - `Agent` (creator_id, version, capabilities)
  - `ComplianceRule` (rule name, verdict, timestamp)
- [ ] Create PostgreSQL schema with immutable constraints:
  ```sql
  CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    audit_record_id VARCHAR(255) UNIQUE NOT NULL,
    mandate_id VARCHAR(255) NOT NULL,
    transaction_id VARCHAR(255) NOT NULL,
    audit_data JSONB NOT NULL,
    hash_sha256 VARCHAR(64) NOT NULL,
    previous_hash_sha256 VARCHAR(64),
    created_at TIMESTAMP DEFAULT NOW(),
    -- Immutable: no updates, no deletes
    CONSTRAINT no_updates CHECK (true)
  );
  CREATE INDEX idx_audit_logs_mandate_id ON audit_logs(mandate_id);
  CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
  ```
- [ ] Implement hash-chain logic (SHA-256, linking previous_hash)
- [ ] Write tests for hash-chain (verify tampering detected)

**Data Engineer (0.5):**
- [ ] Connect to Razorpay payment pipeline (Kafka topic or webhook)
- [ ] Parse incoming UPI Reserve Pay transactions (mandate_id, amount, merchant, timestamp)
- [ ] Create data ingestion service (subscribe to Kafka, validate, enqueue for logging)
- [ ] Write integration test (mock Kafka message → audit log entry)

**Deliverable (End of Week 1):**
- ✅ Empty audit trail table, hash-chain working
- ✅ API endpoint `POST /audit-logs` accepts transaction data
- ✅ Sample transaction logged with proper hash chain
- ✅ Tests: hash chain, immutability constraints, basic ingestion

**Frontend (0.5):**
- [ ] Set up React TypeScript project, Material-UI, basic routing
- [ ] Create `components/AuditTrailDashboard.tsx` (stub)
- [ ] Write API client (`services/api.ts`)

#### Week 2 Tasks

**Backend (1 engineer):**
- [ ] Create API endpoint `GET /audit-logs?mandate_id=X&date_range=Y` (query audit trail)
- [ ] Implement full-text search (Elasticsearch indexing of audit_data JSONB)
- [ ] Add pagination + filtering
- [ ] Write integration tests for query endpoints

**Data Engineer (0.5):**
- [ ] Build sample data generator (10-20 realistic mandates with edge cases):
  - Partial mandates (time window, velocity limits)
  - Expired mandates (test expiry detection)
  - Category blacklist test cases (alcohol, tobacco, gambling)
  - Concurrent transactions (velocity spike)
  - Retry loops (same transaction attempted multiple times)
- [ ] Load sample data into test database
- [ ] Create `data/fixtures/sample_transactions.csv` (1,000 sample UPI transactions for Bigbasket, Vi, Zomato)

**Frontend (0.5):**
- [ ] Build `AuditTrailDashboard.tsx` (table of audit logs, filtering by mandate_id/date)
- [ ] Create transaction detail modal (`TransactionDetail.tsx`)
- [ ] Connect to backend API, render audit logs

**Deliverable (End of Week 2):**
- ✅ Backend: Query API working, Elasticsearch indexed, pagination
- ✅ Data: 1,000+ sample transactions loaded, 20 realistic mandates
- ✅ Frontend: Audit dashboard displays logs
- ✅ Tests: Query, filtering, pagination
- ✅ Database: Append-only working, tampering detected

---

### **WEEK 3-4: Compliance Rules Engine & Report Generation**

**Goal:** Implement 5-7 mandate-breach detection rules; auto-generate 3 compliance reports

#### Week 3 Tasks

**Backend (1 engineer):**
- [ ] Implement 5 core rules in `rules/` directory:
  1. **Mandate Cap Check** (`mandate_cap_check.py`): transaction_amount > mandate_cap → BLOCK
  2. **Merchant Allowlist Check** (`merchant_whitelist_check.py`): merchant not in {allowlist} → BLOCK
  3. **Category Blacklist Check** (`category_blacklist_check.py`): category in {blacklist} → BLOCK
  4. **Time Window Check** (`time_window_check.py`): transaction outside mandate time window → BLOCK
  5. **Mandate Expiry Check** (`mandate_expiry_check.py`): mandate_expiry < current_date → BLOCK

- [ ] For each rule, implement:
  - `evaluate(audit_record, mandate) → RuleVerdict(status, signal, rule_name, verdict)`
  - Log every verdict in audit trail
  - Return Signal → Rule → Verdict tuple

- [ ] Create `services/compliance_service.py` (orchestrates rule evaluation)
  ```python
  class ComplianceService:
      def evaluate_transaction(self, audit_record, mandate):
          """Run all rules, return verdicts"""
          verdicts = []
          for rule in self.rules:
              verdict = rule.evaluate(audit_record, mandate)
              verdicts.append(verdict)
          return ComplianceCheckResult(
              overall_status="APPROVED" if all pass else "REJECTED",
              checks_performed=verdicts
          )
  ```

- [ ] Create API endpoint `POST /compliance/evaluate` (run rules on a transaction)
- [ ] Write unit tests for each rule (edge cases: boundary values, null checks)

**Frontend (0.5):**
- [ ] Create `components/RuleVerdictDisplay.tsx` (render Signal → Rule → Verdict for each check)
- [ ] Show "PASS" vs. "BLOCK" with reasons

**Deliverable (End of Week 3):**
- ✅ 5 rules implemented + tested in isolation
- ✅ Compliance evaluation service working
- ✅ API endpoint returns rule verdicts
- ✅ Frontend displays rule verdicts
- ✅ Tests: 5 rules × edge cases = 20+ test cases

#### Week 4 Tasks

**Backend (1 engineer):**
- [ ] Implement report generators in `templates/` and `services/report_service.py`:

  **1. FREE-AI Compliance Report** (`free_ai_report.jinja2`)
  - Input: date_range, merchant_id
  - Query audit logs for period
  - Map each transaction to FREE-AI pillars:
    - Infrastructure: "Audit trail stored in append-only PostgreSQL, hash-chain verified"
    - Governance: "Audit logs queryable by user/merchant/regulator, immutable"
    - Accountability: "Agent creator identified, action audit trail present"
    - Explainability: "Every rule verdict logged with Signal → Rule → Verdict"
    - etc.
  - Output: HTML + PDF (use ReportLab or WeasyPrint)

  **2. STR Draft Generator** (`str_draft.jinja2`)
  - Input: audit_record with rule_verdict == "BLOCK" for cap breach, category, etc.
  - Auto-populate fields:
    - Transaction ID, amount, merchant
    - Breach reason (e.g., "mandate cap exceeded by ₹1,200")
    - AFRI risk score (if available)
    - Compliance analyst recommendation ("Ready for FIU-IND filing")
  - Output: JSON (for compliance team to review + file)

  **3. DPDP Data Processing Register** (`dpdp_register.jinja2`)
  - Input: date_range, merchant_id
  - For each transaction, log:
    - Personal data captured (intent text, UPI VPA masked, phone masked)
    - Purpose (order fulfillment per user mandate)
    - Consent timestamp
    - Storage duration (7 years per RBI/PMLA)
    - Compliance (✓ purpose-limited, ✓ masked, ✓ consent-documented)
  - Output: HTML + PDF

- [ ] Create API endpoints:
  - `GET /reports/free-ai?start_date=X&end_date=Y&merchant_id=Z` → PDF + JSON
  - `GET /reports/str?audit_record_id=X` → JSON (STR draft)
  - `GET /reports/dpdp?start_date=X&end_date=Y&merchant_id=Z` → PDF + JSON

- [ ] Write integration tests (generate reports, validate content, check PDF rendering)

**Data Engineer (0.5):**
- [ ] Prepare test data for reporting (500 sample transactions across 3 merchants, various rule verdicts)
- [ ] Run compliance reports on test data, validate output

**Frontend (0.5):**
- [ ] Create `components/ComplianceReportViewer.tsx` (display reports in-browser)
- [ ] Add download buttons (PDF, JSON)

**Deliverable (End of Week 4):**
- ✅ 3 compliance reports auto-generated (FREE-AI, STR, DPDP)
- ✅ API endpoints working, reports in PDF + JSON
- ✅ Frontend displays reports
- ✅ Tests: report generation, content validation, PDF rendering
- ✅ Integration test: end-to-end (transaction → audit log → compliance report)

---

### **WEEK 5-6: Integration, Edge Cases, DPDP Compliance**

**Goal:** Integrate with AFRI (optional); handle edge cases; implement DPDP workflows

#### Week 5 Tasks

**Backend (1 engineer):**
- [ ] Add 2 more optional rules:
  - **Velocity Check** (`velocity_check.py`): transactions in time window > limit → FLAG
  - **Category Adjacent Check** (`category_adjacent.py`): "wine glasses" alcohol-adjacent? → MANUAL_REVIEW

- [ ] Implement DPDP-specific features:
  - PII masking (UPI VPA → "****@okhdfcbank", phone → "****1234")
  - Consent timestamp tracking (every mandate creation)
  - Purpose limitation enforcement (intent text only used for fulfillment)
  - Breach notification workflow (if audit log accessed unexpectedly, alert + escalate)

- [ ] Create `utils/masking.py`:
  ```python
  def mask_upi_vpa(vpa: str) -> str:
      # "user@okhdfcbank" → "****@okhdfcbank"
  
  def mask_phone(phone: str) -> str:
      # "9876543210" → "****3210"
  ```

- [ ] Add DPDP audit fields to `AuditLog` model:
  - `dpdp_consent_timestamp`
  - `dpdp_consent_purpose`
  - `pii_fields_masked` (bool)
  - `breach_notification_enabled` (bool)

- [ ] Create breach notification service (if audit log accessed by unauthorized user, trigger alert):
  - Log access event
  - Send alert to Razorpay compliance team
  - Prepare notification template for user
  - Escalate to FIU-IND if financial data exposed

- [ ] Write tests for PII masking, breach scenarios

**Frontend (0.5):**
- [ ] Create `components/MandateManager.tsx` (create/edit mandate, display consent template)
- [ ] Show consent text: "Agent will capture your intent, phone, and mandate. Purpose: order fulfillment. Stored 7 years per RBI. Your rights: access, correction, deletion after hold."

**Quality Assurance (0.5):**
- [ ] Set up automated test suite (pytest, coverage >80%)
- [ ] Create test report (HTML, coverage breakdown)
- [ ] Identify gaps in edge case coverage

**Deliverable (End of Week 5):**
- ✅ 7 rules total (5 core + 2 optional)
- ✅ PII masking working, DPDP fields in schema
- ✅ Breach notification workflow implemented
- ✅ Mandate creation with consent tracking
- ✅ Tests: 50+ test cases covering rules, masking, DPDP compliance, edge cases
- ✅ Test coverage: >80%

#### Week 6 Tasks

**Backend (1 engineer):**
- [ ] Integration with AFRI (if AFRI MVP is ready):
  - Consume AFRI risk_score from Kafka topic
  - Add risk_score as 7th input signal to compliance checks
  - Display AFRI risk_score in audit trail + compliance report
  - If AFRI not ready, mock it (return risk_score between 0-100 for testing)

- [ ] Handle edge cases discovered in Week 5 testing:
  - Partial mandates (time window without cap)
  - Expired mandates mid-transaction
  - Concurrent transactions (race condition handling)
  - Retry loops (same transaction attempted multiple times, should be deduplicated)
  - Category ambiguity (is "wine glasses" alcohol? → handled by category-adjacent rule)
  - Mandate with 0 cap (edge case)
  - Very large amounts (₹1,00,000+, premium MCC)

- [ ] Add database integrity checks (Alembic migrations for schema changes)
- [ ] Performance testing: audit trail queries on 1M+ records (target: <100ms response)

**Frontend (0.5):**
- [ ] Build `pages/Mandates.tsx` (list, create, edit, delete mandates)
- [ ] Add filtering/search for mandates

**Data & Testing (1):**
- [ ] Generate 10K realistic test transactions (edge cases, various merchants, rule violations)
- [ ] Load into test database
- [ ] Run full compliance pipeline (ingestion → rules → reports)
- [ ] Validate output (rule verdicts, reports, PII masking)

**Deliverable (End of Week 6):**
- ✅ AFRI integration (or mock)
- ✅ Edge cases handled (20+ edge case test scenarios)
- ✅ Performance: audit queries <100ms on 1M records
- ✅ 10K test transactions processed end-to-end
- ✅ All 3 compliance reports generated + validated
- ✅ UI for mandate management
- ✅ Tests: 100+ test cases, >85% coverage

---

### **WEEK 7: Certification Badge, Merchant Onboarding, Documentation**

**Goal:** Certification system live; merchant onboarding workflow; production-ready docs

#### Week 7 Tasks

**Backend (1 engineer):**
- [ ] Implement certification badge system:
  - Create `Certification` model (merchant_id, certification_date, expiry_date, badge_id)
  - API endpoint `POST /certifications/issue` (issue badge to merchant after compliance audit)
  - API endpoint `GET /certifications/{certification_id}` (retrieve badge details)
  - Badge signature (cryptographic proof of Razorpay verification)

- [ ] Create onboarding workflow:
  - API endpoint `POST /merchants/register` (register new merchant)
  - Collect: merchant_id, merchant_name, business_address, KYC status
  - Create initial `Mandate` template for merchant
  - Send onboarding email with next steps

- [ ] Prepare production deployment:
  - Database migrations (Alembic)
  - Environment configuration (prod secrets)
  - Health check endpoint (`GET /health` returns DB connection status, Kafka status, etc.)
  - Logging configuration (structured JSON logs, ELK integration)

**Frontend (0.5):**
- [ ] Create `components/CertificationBadge.tsx` (display badge, verification link)
- [ ] Add onboarding flow in `pages/Settings.tsx` (register merchant, view badge)

**Documentation (1):**
- [ ] Write comprehensive docs:
  - `ARCHITECTURE.md` (system design, data flow, compliance mappings)
  - `API_REFERENCE.md` (all endpoints, request/response schemas)
  - `DATABASE_SCHEMA.md` (audit_logs table design, constraints, indexes)
  - `COMPLIANCE_FRAMEWORK.md` (how each feature maps to FREE-AI, DPDP, PMLA)
  - `DEPLOYMENT.md` (how to deploy: Docker, K8s, environment setup)
  - `TESTING.md` (how to run tests, generate coverage reports)

**Quality Assurance:**
- [ ] Final security audit (code review, OWASP checks, SQL injection tests)
- [ ] Penetration testing (attempt to tamper with audit logs, bypass rules)
- [ ] Performance testing (load test: 1,000 concurrent requests, 10K transactions/sec)

**Deliverable (End of Week 7):**
- ✅ Certification badge system live
- ✅ Merchant onboarding workflow
- ✅ Production deployment ready (migrations, configs, health checks)
- ✅ Comprehensive documentation
- ✅ Security audit passed
- ✅ Performance benchmarks: <100ms audit queries, <500ms report generation
- ✅ Ready for 3 pilot merchants (Bigbasket, Vi, Zomato)

---

### **WEEK 8: Go-Live & Buildathon Submission**

**Goal:** Deploy to staging/production; onboard pilot merchants; prepare buildathon submission

#### Week 8 Tasks

**DevOps (0.5):**
- [ ] Deploy to staging environment (Razorpay cloud)
- [ ] Connect to real Razorpay payment pipeline (Kafka topic for real transactions)
- [ ] Run smoke tests (transaction → audit log → report generation)
- [ ] Set up monitoring (Prometheus, Grafana dashboards)
- [ ] Create runbooks (how to respond to alerts, how to troubleshoot)

**Merchant Onboarding (1):**
- [ ] Contact Bigbasket, Vi, Zomato compliance leads
- [ ] Walk through system demo (audit dashboard, compliance reports, certification badge)
- [ ] Onboard each merchant (create mandate templates, load historical data if available)
- [ ] Run first compliance report for each merchant (validate output, get sign-off)

**Frontend (0.5):**
- [ ] Polish UI (design refinement, responsive layout)
- [ ] Add demo mode (pre-loaded data for buildathon judges)
- [ ] Create landing page explaining FREE-AI + DPDP + NPCI UAP

**Buildathon Submission (1 PM + founder):**
- [ ] Update pitch deck (with screenshots, metrics, testimonials from merchants)
- [ ] Write 2-minute demo script
- [ ] Prepare live demo walkthrough:
  - Show audit dashboard
  - Filter by mandate_id, view transaction detail
  - Run compliance report (generate FREE-AI + STR + DPDP reports)
  - Explain rule verdict logic
  - Show certification badge
- [ ] Prepare FAQ responses (based on QUICKSTART.md)

**Deliverable (End of Week 8):**
- ✅ System deployed to staging with real payment data
- ✅ 3 pilot merchants onboarded, first compliance reports generated
- ✅ Monitoring + alerting active
- ✅ Buildathon submission ready:
  - Pitch deck (updated with metrics, screenshots)
  - Live demo (working system)
  - Technical documentation
  - Regulatory grounding (FREE-AI Framework mapping, DPDP compliance, PMLA/FIU-IND integration)
  - Revenue model + financial projections
- ✅ Postmortem: what worked, what to improve, roadmap for Year 2

---

## PART 3: TESTING STRATEGY

### Test Pyramid

```
                  /\
                 /  \         E2E Tests (5% of test suite)
                /    \        - Full workflow: transaction → audit → report
               /------\
              /        \     Integration Tests (20%)
             /          \    - API endpoints
            /            \   - Database operations
           /              \  - Report generation
          /________________\ 
         Unit Tests (75%)
         - Individual rules, hash chain, masking, validators
```

### Testing Checklist

#### Unit Tests (pytest)
- [ ] Hash chain logic (SHA-256, previous_hash linking, tampering detection)
- [ ] Each rule (mandate cap, allowlist, blacklist, time window, expiry, velocity)
- [ ] PII masking (UPI, phone, intent)
- [ ] Date parsing, validators
- [ ] **Coverage target: >85%**

#### Integration Tests (pytest + testcontainers)
- [ ] Database: append-only constraints, immutability
- [ ] API: POST /audit-logs, GET /audit-logs, /compliance/evaluate, /reports/*
- [ ] Kafka ingestion: transaction → audit log
- [ ] Report generation: SQL query → Jinja2 template → PDF/JSON
- [ ] End-to-end: sample transaction → audit log → compliance report

#### E2E Tests (Playwright/Cypress)
- [ ] UI flow: login → view mandates → run compliance report → download
- [ ] Dashboard: filter audit logs, view transaction detail, refresh
- [ ] Merchant onboarding: register → create mandate → receive certification badge

#### Data Validation Tests (Great Expectations)
- [ ] Audit trail completeness (100% of transactions logged)
- [ ] Hash chain integrity (no gaps, proper linking)
- [ ] Rule verdict validity (PASS/BLOCK only, timestamp present)
- [ ] Report content (correct FREE-AI pillars covered, STR fields populated)
- [ ] PII masking (no raw phone numbers or full UPI VPA in reports)

#### Load Tests (Locust)
- [ ] Simulate 1,000 concurrent requests to `/audit-logs` query endpoint
- [ ] Target: <100ms response time (p99)
- [ ] Simulate report generation on 10K+ transactions
- [ ] Target: <500ms response time

#### Security Tests
- [ ] Attempt to modify audit log (should fail due to immutable constraints)
- [ ] Attempt to delete audit log (should fail due to immutable constraints)
- [ ] SQL injection in query filters (should be sanitized)
- [ ] PII exposure (should be masked in reports)

### Test Data

**Fixtures to Generate (in `data/fixtures/`):**
```
Sample Mandates (20):
  - Normal mandate (cap ₹5,000, Bigbasket only, groceries)
  - Premium MCC mandate (cap ₹1,00,000, mutual funds)
  - Expired mandate (should fail)
  - No time window (anytime)
  - Multiple merchants (Bigbasket + Amazon)
  - Category blacklist (alcohol, tobacco, gambling)

Sample Transactions (10,000):
  - Normal transactions (should PASS all rules)
  - Mandate cap breached (should BLOCK on cap check)
  - Wrong merchant (should BLOCK on allowlist check)
  - Blacklisted category (should BLOCK on category check)
  - Outside time window (should BLOCK on time check)
  - Expired mandate (should BLOCK on expiry check)
  - Velocity spike (should FLAG on velocity check)
  - Category adjacent (wine glasses, should MANUAL_REVIEW)
  - Retry loop (same transaction 10x, deduplicate)
  - Concurrent transactions (race condition test)

Edge Cases:
  - Mandate with ₹0 cap
  - Very large amount (₹1,00,000+)
  - Fractional amounts (₹123.45)
  - Null fields (missing phone, VPA, etc.)
  - Special characters in intent ("buy me कुछ vegetables" - Unicode)
```

---

## PART 4: DEPLOYMENT & PRODUCTION CHECKLIST

### Pre-Production (Week 7 End)

- [ ] Security audit passed (code review, OWASP, penetration testing)
- [ ] Performance benchmarks met (<100ms queries, <500ms reports)
- [ ] Database backups automated (daily snapshots, 7-year retention)
- [ ] Logging & monitoring configured (ELK stack, Prometheus)
- [ ] SSL/TLS certificates provisioned (HTTPS only)
- [ ] API rate limiting configured (prevent abuse)
- [ ] CORS policy configured (allow Razorpay domains only)

### Staging Deployment (Week 8 Start)

```bash
# Docker build
docker build -t razorpay-atl-india:latest .

# Push to registry
docker push razorpay.ecr.io/atl-india:latest

# Deploy to staging (K8s or docker-compose)
kubectl apply -f k8s/staging/deployment.yaml
```

### Production Deployment (Week 8 Mid)

```bash
# Promote from staging to production
kubectl set image deployment/atl-india \
  app=razorpay.ecr.io/atl-india:latest \
  --record

# Monitor rollout
kubectl rollout status deployment/atl-india

# Health check
curl https://atl-india.razorpay.io/health
```

### Monitoring & Alerting

**Prometheus metrics:**
```
atl_audit_logs_total (counter: total audit logs created)
atl_rule_verdict_seconds (histogram: rule evaluation time)
atl_report_generation_seconds (histogram: report gen time)
atl_database_query_seconds (histogram: DB query latency)
atl_pii_masking_failures (counter: failed masking attempts)
```

**Grafana dashboards:**
- Real-time audit log volume (transactions/sec)
- Rule verdict distribution (PASS vs. BLOCK)
- Report generation metrics (avg time, P99 latency)
- Database performance (connection pool, query latency)
- Error rates (failed rules, DB errors, API errors)

**Alerts (to Razorpay on-call):**
- Audit log writes >10% failures (database issue)
- Report generation >1 second (performance degradation)
- Hash chain verification failures (tampering detected)
- PII masking failures (compliance risk)
- 5xx error rate >1% (API errors)

---

## PART 5: DELIVERABLES CHECKLIST

### Code Deliverables

- [ ] **Backend (Python/FastAPI)**
  - Git repo: `razorpay-atl-india-backend`
  - Core services: audit trail, compliance rules, report generation
  - API: 10+ endpoints (audit logs, mandates, reports, compliance evaluation)
  - Tests: 100+ test cases, >85% coverage
  - Docs: Architecture, API reference, deployment guide

- [ ] **Frontend (React/TypeScript)**
  - Git repo: `razorpay-atl-india-frontend`
  - Pages: Dashboard, audit logs, compliance reports, mandates, settings
  - Components: 15+ reusable components
  - Tests: E2E tests for critical flows
  - Responsive design (mobile, tablet, desktop)

- [ ] **Data & Fixtures**
  - Git repo: `razorpay-atl-india-data`
  - 10K realistic test transactions (CSV)
  - 20 test mandates (JSON)
  - Sample merchants (Bigbasket, Vi, Zomato)
  - Edge case scenarios (expired, concurrent, etc.)

- [ ] **Infrastructure**
  - Dockerfile (backend + frontend)
  - docker-compose.yml (local dev: PostgreSQL, Redis, Kafka, services)
  - K8s manifests (staging/prod deployments)
  - GitHub Actions CI/CD (test, build, deploy)
  - Runbooks (deployment, troubleshooting, escalation)

### Documentation Deliverables

- [ ] **README.md** (project overview, quick start)
- [ ] **ARCHITECTURE.md** (system design, data flow, compliance mappings)
- [ ] **API_REFERENCE.md** (endpoint docs, request/response schemas)
- [ ] **DATABASE_SCHEMA.md** (audit_logs table, constraints, indexes)
- [ ] **COMPLIANCE_FRAMEWORK.md** (FREE-AI, DPDP, PMLA/FIU-IND mapping)
- [ ] **TESTING.md** (how to run tests, coverage reports)
- [ ] **DEPLOYMENT.md** (how to deploy, monitoring, alerts)
- [ ] **MERCHANT_ONBOARDING.md** (how to onboard merchants, create mandates)

### Buildathon Submission Deliverables

- [ ] **Pitch Deck** (5 slides: problem, solution, leverage, go-to-market, ask)
  - Screenshots of working system
  - Metrics (transactions processed, rule verdicts, reports generated)
  - Testimonial from 1 pilot merchant (Bigbasket, Vi, or Zomato)
  - Financial model (₹5.5-6Cr Year 1)

- [ ] **Demo Video** (2 minutes)
  - Audit dashboard walk-through
  - Compliance report generation
  - Rule verdict explanation
  - Certification badge

- [ ] **Live Demo System** (accessible in buildathon room)
  - Pre-loaded with pilot merchant data
  - Fully functional: can query audit logs, generate reports
  - Demo mode: show different rule verdicts, merchants

- [ ] **Technical Deep-Dive Document** (10-15 pages)
  - Problem statement (regulatory gap)
  - Regulatory grounding (FREE-AI Framework, DPDP Rules, PMLA/FIU-IND)
  - Architecture (4-layer design, schema, API)
  - Implementation details (rules, reports, masking)
  - Testing & validation (100+ test cases, edge cases)
  - Production readiness (security, performance, monitoring)

- [ ] **Source Code** (GitHub repo link)
  - All code public/private as appropriate
  - README with setup instructions
  - Tests passing, coverage >85%
  - Deployment guide

---

## PART 6: RAZORPAY RESOURCES & INTEGRATIONS

### What Razorpay Provides (Assumed Available)

- [ ] **Payment Data Access:**
  - Kafka topic with real UPI Reserve Pay transactions
  - Mandate metadata (cap, allowlist, blacklist, time window, expiry)
  - Merchant data (merchant_id, merchant_name, category)
  - Historical transaction data (for backfill)

- [ ] **Infrastructure:**
  - Cloud account (AWS/GCP)
  - PostgreSQL managed database (RDS/Cloud SQL)
  - Kafka cluster (for real-time data)
  - Redis cluster (for caching)
  - Elasticsearch cluster (for audit log search)
  - Container registry (ECR, Artifact Registry)
  - CI/CD platform (GitHub Actions, GitLab CI)
  - Monitoring stack (Prometheus, Grafana, ELK)

- [ ] **Team Support:**
  - Payment data engineer (help with Kafka ingestion)
  - DBA (help with PostgreSQL schema, migrations)
  - Security engineer (help with PII masking, encryption)
  - DevOps engineer (help with deployment, monitoring)
  - Compliance officer (validate DPDP, PMLA implementation)

- [ ] **Merchant Access:**
  - Credentials for Bigbasket, Vi, Zomato staging environments
  - Sandbox/test UPI Reserve Pay mandates
  - Historical transaction data for backfill

### Integration Points

1. **Razorpay Payment Pipeline → ATL-India**
   - Kafka topic: `razorpay.upi.reserve_pay.transactions`
   - Consumer: ATL-India ingestion service
   - Message format: `{mandate_id, transaction_id, merchant_id, amount, timestamp}`

2. **Razorpay KYC/Merchant Database → ATL-India**
   - Query: merchant KYC status, merchant_name, merchant_category
   - API: Razorpay internal merchant API (read-only)

3. **IDEA_6 (AFRI) Fraud Detection → ATL-India**
   - Kafka topic: `razorpay.afri.risk_scores`
   - Consumer: ATL-India compliance service
   - Message format: `{transaction_id, risk_score (0-100), anomalies_detected}`
   - Integration: display AFRI risk_score alongside rule verdicts

4. **ATL-India → Merchant Dashboard**
   - API: Razorpay Merchant Portal can embed audit dashboard iframe
   - Endpoint: `https://atl-india.razorpay.io/dashboard?merchant_id=X&api_key=Y`

5. **ATL-India → Compliance Team Internal Tools**
   - API: export STR drafts to internal compliance system
   - Webhook: alert when high-risk transaction flagged

---

## PART 7: RISK MITIGATION & CONTINGENCY

### If Behind Schedule

**Prioritize (in order):**
1. Audit trail logging (immutable, hash-chain) — CRITICAL
2. Mandate-breach detection rules (5 core rules) — CRITICAL
3. Compliance reports (FREE-AI, STR, DPDP) — HIGH
4. Certification badge — MEDIUM
5. AFRI integration — LOW (can be mocked)
6. Frontend polish — LOW (MVP-level UI acceptable)

**If running out of time:**
- Scope down rules (keep 5 core, drop velocity + category-adjacent)
- Keep reports basic (text-based, not fancy PDF rendering)
- Use mock data instead of real Razorpay pipeline
- Deliver CLI tool instead of full web UI (still functional)

### If Data Pipeline Not Ready

- [ ] Use mock data generator (simulate 10K transactions daily)
- [ ] Hardcode Kafka messages in test fixtures
- [ ] Can still validate end-to-end flow
- [ ] Integration with real pipeline happens later (Week 8 easy swap)

### If Merchant Onboarding Blocked

- [ ] Use internal Razorpay test merchants
- [ ] Create synthetic Bigbasket/Vi/Zomato merchants for demo
- [ ] Can still show working system with demo data

### If Deployment Platform Issues

- [ ] Fall back to Docker Compose (local development)
- [ ] Deploy to cheaper/easier cloud (AWS EC2 instead of K8s)
- [ ] Still production-ready, just less scalable

---

## PART 8: SUCCESS CRITERIA (GO/NO-GO GATES)

### End of Week 2 (Go/No-Go for Week 3-4)
- [ ] Audit trail logging working (transactions appear in DB)
- [ ] Hash chain verified (no tampering detected)
- [ ] 1,000 sample transactions loaded
- [ ] Query API working, dashboard displaying logs

**Go:** Proceed to compliance rules + reports  
**No-Go:** Debug logging/hash-chain before moving on

### End of Week 4 (Go/No-Go for Week 5-6)
- [ ] 5 rules implemented + passing tests
- [ ] 3 compliance reports generated (FREE-AI, STR, DPDP)
- [ ] 10K test transactions processed end-to-end
- [ ] All reports validated (content, formatting, PDFs render)

**Go:** Proceed to edge cases + DPDP implementation  
**No-Go:** Fix report generation, re-test, delay Week 5

### End of Week 6 (Go/No-Go for Week 7-8)
- [ ] 7 rules total, 100+ test cases, >80% coverage
- [ ] Edge cases handled (partial mandates, expired, concurrent, retries)
- [ ] DPDP compliance: PII masking, consent tracking, breach notification
- [ ] Performance: <100ms audit queries, <500ms reports on 10K+ transactions

**Go:** Proceed to certification + production deployment  
**No-Go:** Fix edge cases, performance-tune, delay Week 7

### End of Week 7 (Go/No-Go for Buildathon)
- [ ] Security audit passed
- [ ] Performance benchmarks met
- [ ] Comprehensive documentation
- [ ] Deployed to staging, health checks passing
- [ ] 3 pilot merchants onboarded, first compliance reports approved

**Go:** Ready for buildathon submission  
**No-Go:** Fix critical issues, delay submission to next week

---

## PART 9: POST-MVP ROADMAP (Year 1-2)

### Q4 2026 (Month 3-4 Post-MVP)
- [ ] Scale to 10-20 merchants (beyond 3 pilots)
- [ ] White-label licensing conversations (Cashfree, PayU)
- [ ] Integrate real AFRI fraud detection (if available)
- [ ] Performance optimization (1M+ audit logs)

### Q1 2027 (Month 5-8)
- [ ] Public beta launch (for 50+ merchants)
- [ ] White-label partner 1 live (Cashfree or PayU)
- [ ] Advanced analytics (cohort analysis, fraud trends)
- [ ] Multi-region support (ASEAN expansion prep)

### Q2 2027 (Month 9-12)
- [ ] Full public launch (100+ merchants)
- [ ] White-label partner 2 live
- [ ] Regulatory data licensing (NPCI, RBI anonymized patterns)
- [ ] Insurance partnerships (risk models, referral revenue)

---

## PART 10: TEAM ASSIGNMENTS & COMMUNICATION

### Team Structure (3.5 FTE)

| Role | Person | Weeks | Focus |
|---|---|---|---|
| **Backend Engineer** | TBD | 1-8 | Audit trail, rules, reports, APIs |
| **Data Engineer** | TBD | 1-8 | Data ingestion, fixtures, performance testing |
| **Frontend Engineer** | TBD | 1-8 | Dashboard, UI, E2E tests |
| **Product Manager** | TBD | 2-8 (0.5 FTE) | Merchant validation, roadmap, buildathon pitch |
| **QA Engineer** | TBD | 4-8 (0.5 FTE) | Test strategy, security audit, load testing |
| **DevOps** | TBD | 6-8 (0.5 FTE) | Deployment, monitoring, runbooks |

### Weekly Standup Agenda (Tuesdays, 10 AM)
1. What did we ship? (metrics: commits, PRs merged, tests added)
2. What's blocking? (escalations, data access, infrastructure issues)
3. What's next? (Weekly sprint goals)
4. Risk register (any new risks or blockers?)

### Sprint Planning (Fridays, 4 PM)
- Review week's achievements
- Plan next week's tasks (update Jira/GitHub projects)
- Identify blockers early
- Adjust scope if needed

### Escalation Path
- Engineering blockers → Lead Engineer (Razorpay CTO)
- Data access issues → Data team lead
- Merchant feedback → Product Manager (relay to engineering)
- Deployment issues → DevOps lead

---

## SUMMARY: THIS IS THE FULL BUILD PLAN

**This document is your execution roadmap for the next 8 weeks.** Every engineer should have a copy, every manager should track progress against these milestones, and the team should sync weekly on blockers.

**Key principles:**
1. **Immutable audit trail first** — foundation for everything else
2. **Rules-based compliance** — explainable, testable, not black-box ML
3. **Real data from Week 1** — not mock data, not spreadsheets
4. **Comprehensive testing** — >85% coverage, edge cases, load testing
5. **Production-ready by Week 8** — not "almost works," fully deployable

**If you stick to this plan, you'll ship a buildathon-ready MVP that solves a real, urgent, domestic Indian problem, grounded in live regulatory frameworks and live merchant demand.**

Let's build it.

---

**Version:** 1.0 | **Date:** September 15, 2026 | **Status:** Ready for Engineering Kickoff
