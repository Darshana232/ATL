/** Response shapes, mirroring what the API returns. */

export interface Overview {
  mandates: { active: number; revoked: number };
  agents: { active: number };
  decisions: { total: number; pass: number; flag: number; block: number };
  payments: { captured: number; failed: number; capturedPaise: number; simulatedCaptured: number };
  audit: { events: number; checkpoints: number; authRejections: number };
  simulation: string;
}

export interface DecisionSummary {
  id: string; verdict: 'PASS' | 'FLAG' | 'BLOCK'; reason: string;
  engineVersion: string; mandateId: string; mandateVersion: number;
  agentId: string; merchantId: string; amountPaise: number;
  paymentMethod: string; userIntent: string | null;
  spentBeforePaise: number; evaluationDurationUs: number | null;
  riskScore: number | null; riskProvider: string | null;
  evaluatedAt: string;
  payment: { id: string; status: string; provider: string; simulated: boolean } | null;
}

export interface RuleEvaluation {
  ruleCode: string; sequence: number; verdict: 'PASS' | 'FLAG' | 'BLOCK' | 'SKIP';
  signal: string; expected: string; actual: string; reason: string;
  observedPaise: number | null; limitPaise: number | null;
}

export interface DecisionDetail extends Omit<DecisionSummary, 'payment'> {
  cart: unknown; spendWindowStart: string; spendWindowEnd: string;
  evaluations: RuleEvaluation[];
}

export interface MandateRow {
  id: string; userId: string; agentId: string; label: string;
  status: string; createdAt: string; revokedAt: string | null; revokedReason: string | null;
  version: number; perTxnLimitPaise: number; windowLimitPaise: number;
  windowKind: string; maxTxnPerHour: number; timezone: string;
  windowStartHour: number; windowEndHour: number;
  validFrom: string; validTo: string; merchantIds: string[]; capturedPaise: number;
}

export interface AgentRow {
  id: string; displayName: string; vendor: string; modelId: string | null;
  agentVersion: string; status: string; registeredAt: string;
  tools: string[]; activeCredentials: number; decisions: number; blocks: number;
}

export interface PaymentRow {
  id: string; mandateId: string; decisionId: string; agentId: string;
  merchantId: string; amountPaise: number; provider: string;
  providerPaymentId: string | null; status: string;
  failureCode: string | null; failureReason: string | null;
  createdAt: string; capturedAt: string | null; simulated: boolean;
}

export interface RiskRow {
  id: string; provider: string; score: number; band: string; reasons: string[];
  latencyMs: number | null; isAdvisory: boolean;
  decisionId: string | null; verdict: string | null;
  agentId: string; amountPaise: number; createdAt: string;
}

export interface AuditEvent {
  seq: number; id: string; eventType: string; occurredAt: string;
  actorKind: string; actorId: string | null;
  subjectKind: string; subjectId: string;
  requestId: string | null; mandateId: string | null;
  payload: unknown; payloadHash: string; prevHash: string | null; hash: string;
}

export interface VerificationResult {
  chainId: string; status: 'intact' | 'broken';
  eventsChecked: number; totalEvents: number;
  firstBreak: { seq: number; eventId: string; kind: string; detail: string } | null;
  headHash: string | null;
  checkpoints: { id: string; seq: number; createdAt: string; status: string; detail: string }[];
  verifiedAt: string; durationMs: number; limitation: string;
}

export interface CoverageReport {
  coverage: string; controlsCovered: number; controlsTotal: number; notImplemented: number;
  bySutra: { sutra: string; covered: number; total: number }[];
  byPillar: { pillar: string; covered: number; total: number }[];
  controls: {
    id: string; title: string; description: string; sutra: string; pillar: string;
    status: string; evidenceCount: number; evidenceLabel: string;
    evidenceSample: string | null; limitation: string | null; gap: string | null;
  }[];
  gaps: string[]; limitations: string[]; caveat: string;
  generatedAt: string; periodStart: string; periodEnd: string;
}

export interface StrDraft {
  status: string; candidateCount: number; generatedAt: string;
  periodStart: string; periodEnd: string;
  candidates: {
    reason: string; title: string; narrative: string; occurredAt: string;
    mandateId: string | null; agentId: string | null; decisionId: string | null;
    amountPaise: number | null; ruleCode: string | null; evidenceRefs: string[];
  }[];
  reportingEntity: { name: string; registrationStatus: string; finnetAccess: string };
  caveat: string; nextStep: string;
}

export interface DpdpRegister {
  records: {
    id: string; dataCategory: string; fields: string[]; purpose: string;
    legalBasis: string; source: string; retention: string; minimisation: string;
    accessControl: string; isPersonalData: boolean; recordCount: number | null;
  }[];
  personalDataCategories: number; controlsInPlace: number;
  privacyControlCoverage: string;
  gaps: { id: string; title: string; detail: string; plannedIn: string }[];
  caveat: string; generatedAt: string;
}
