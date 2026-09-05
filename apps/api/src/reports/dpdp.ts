/**
 * DPDP data-processing register.
 *
 * ========================== WHAT WE DO NOT CLAIM =========================
 * We do NOT claim to be "DPDP compliant". The DPDP Rules 2025 were notified on
 * 13 Nov 2025 but are PHASED: the Data Protection Board took effect
 * immediately, Consent Manager registration and penalties land 13 Nov 2026, and
 * the full notice/consent/security/rights obligations land 13 MAY 2027.
 *
 * So the honest framing is not "we are compliant today" - nobody is required to
 * be. It is: obligations arrive within months, the missing control is
 * MACHINE-GENERATED EVIDENCE, and here is ours with its gaps named.
 *
 * See RESEARCH_REALITY_CHECK item 2.
 * =========================================================================
 *
 * THE DECLARATION IS IN CODE; THE COUNTS ARE QUERIES. Purpose, legal basis and
 * retention are human judgements and belong in a reviewed source file. Row
 * counts are facts and belong in the database. Mixing them would let a stale
 * declaration hide behind a live number.
 */
import type pg from 'pg';

export interface ProcessingRecord {
  readonly id: string;
  readonly dataCategory: string;
  /** The columns, named exactly. Vagueness here is how registers become fiction. */
  readonly fields: readonly string[];
  readonly purpose: string;
  readonly legalBasis: string;
  readonly source: string;
  readonly retention: string;
  /** What we do so this data is less dangerous to hold. */
  readonly minimisation: string;
  readonly accessControl: string;
  /** Live count query. `null` for records with nothing countable. */
  readonly countQuery: string | null;
  readonly isPersonalData: boolean;
}

/**
 * The register.
 *
 * Note how much of the "minimisation" column is a SCHEMA CONSTRAINT rather than
 * a policy. That is the strongest kind of privacy control: data never collected
 * cannot leak, cannot be subpoenaed and cannot be mishandled. Everything else -
 * encryption, access control, redaction - reduces risk without eliminating it.
 */
export const PROCESSING_RECORDS: readonly ProcessingRecord[] = [
  {
    id: 'DP-01',
    dataCategory: 'User identity',
    fields: ['users.external_ref_hash', 'users.display_name'],
    purpose: 'Recognise a returning user and attribute a mandate to a person.',
    legalBasis: 'Consent, recorded per mandate version (consent_ref, consent_at).',
    source: 'Provided at registration by the upstream system.',
    retention: 'For the life of the account plus the audit retention period.',
    minimisation:
      'The real-world identifier is stored ONLY as a SHA-256 hash, enforced by ' +
      'CHECK (external_ref_hash ~ \'^[0-9a-f]{64}$\'). We can recognise a ' +
      'returning user without ever storing who they are.',
    accessControl: 'atl_app has SELECT/INSERT/UPDATE; no DELETE anywhere.',
    countQuery: 'SELECT count(*)::bigint AS count FROM users',
    isPersonalData: true,
  },
  {
    id: 'DP-02',
    dataCategory: 'Contact details',
    fields: ['users.phone_last4', 'users.upi_vpa_masked', 'users.upi_handle'],
    purpose: 'Let a user recognise their own account and payment instrument.',
    legalBasis: 'Consent.',
    source: 'Provided at registration, already reduced.',
    retention: 'Life of the account.',
    minimisation:
      'THERE IS NOWHERE TO PUT A FULL PHONE NUMBER. `phone_last4` is CHECKed to ' +
      'be exactly four digits and `upi_vpa_masked` is CHECKed to start with at ' +
      'least two asterisks. Application code cannot store more even if it tried.',
    accessControl: 'Same as DP-01. Redacted from all logs by the pino config.',
    countQuery: 'SELECT count(*)::bigint AS count FROM users WHERE phone_last4 IS NOT NULL',
    isPersonalData: true,
  },
  {
    id: 'DP-03',
    dataCategory: 'Banking reference',
    fields: ['users.bank_ifsc', 'users.bank_name', 'users.bank_supports_upi'],
    purpose: 'Validate a payment instrument and display the issuing bank.',
    legalBasis: 'Consent; necessary for the service the user asked for.',
    source: 'Razorpay public IFSC API, cold path only - never during authorization.',
    retention: 'Life of the account.',
    minimisation:
      'IFSC identifies a BRANCH, not a person, and no account number is stored ' +
      'anywhere in this system.',
    accessControl: 'Same as DP-01.',
    countQuery: 'SELECT count(*)::bigint AS count FROM users WHERE bank_ifsc IS NOT NULL',
    isPersonalData: true,
  },
  {
    id: 'DP-04',
    dataCategory: 'Spending mandate terms',
    fields: ['mandate_versions.*'],
    purpose: 'Decide whether an agent-initiated payment is permitted.',
    legalBasis: 'Consent, recorded on every version and enforced NOT NULL.',
    source: 'Set by the user when creating or amending a mandate.',
    retention:
      'Permanent and immutable. A decision made under version 1 must stay ' +
      'explainable against version 1 forever.',
    minimisation:
      'Limits and categories only. A mandate contains no contact details and no ' +
      'payment instrument.',
    accessControl: 'Append-only: no UPDATE or DELETE for the application role.',
    countQuery: 'SELECT count(*)::bigint AS count FROM mandate_versions',
    isPersonalData: true,
  },
  {
    id: 'DP-05',
    dataCategory: 'Natural-language user intent',
    fields: ['authorization_requests.user_intent'],
    purpose:
      'Explainability and dispute resolution - answering "why did the agent buy ' +
      'this?" months later.',
    legalBasis: 'Consent; legitimate use for dispute resolution.',
    source: 'The instruction the user gave their agent.',
    retention: 'With the authorization record. Append-only.',
    minimisation:
      'Optional and capped at 2,000 characters. Collected because a specific ' +
      'purpose was identified FIRST, not by default and justified afterwards.',
    accessControl: 'Admin key required to read. Not exposed to any agent.',
    countQuery:
      'SELECT count(*)::bigint AS count FROM authorization_requests WHERE user_intent IS NOT NULL',
    isPersonalData: true,
  },
  {
    id: 'DP-06',
    dataCategory: 'Transaction records',
    fields: ['authorization_requests.*', 'decisions.*', 'payments.*'],
    purpose: 'Authorize payments, produce evidence, and reconcile with providers.',
    legalBasis: 'Necessary for performance of the service; regulatory record-keeping.',
    source: 'Generated by the system.',
    retention:
      'Seven years, matching the ordinary financial record-keeping expectation. ' +
      'NOTE: no automated retention job exists yet - see the gaps below.',
    minimisation:
      'Amounts, merchant ids and verdicts. No card, account or VPA details are ' +
      'stored on a transaction.',
    accessControl: 'Append-only except the payment status lifecycle.',
    countQuery: 'SELECT count(*)::bigint AS count FROM authorization_requests',
    isPersonalData: true,
  },
  {
    id: 'DP-07',
    dataCategory: 'Audit trail',
    fields: ['audit_events.payload'],
    purpose: 'Tamper-evident record of every consequential action.',
    legalBasis: 'Regulatory record-keeping; legitimate use.',
    source: 'Generated by the system.',
    retention: 'Seven years. Append-only and hash-chained.',
    minimisation:
      'Payloads are built from an EXPLICIT ALLOWLIST of fields, never by ' +
      'spreading a request object. An allowlist fails closed, so a field added ' +
      'to the API later stays out of the hashed trail until someone puts it ' +
      'there deliberately.',
    accessControl:
      'No UPDATE or DELETE for any role without disabling a trigger, which is ' +
      'owner-only DDL that PostgreSQL logs.',
    countQuery: 'SELECT count(*)::bigint AS count FROM audit_events',
    isPersonalData: true,
  },
  {
    id: 'DP-08',
    dataCategory: 'Agent credentials',
    fields: ['agent_credentials.public_key_spki_b64', 'agent_credentials.public_key_fingerprint'],
    purpose: 'Verify that a request genuinely came from a registered agent.',
    legalBasis: 'Necessary for security of processing.',
    source: 'Registered by the agent operator.',
    retention: 'Until revoked, then retained for the audit period.',
    minimisation:
      'PUBLIC KEYS ONLY. No secret is stored, so a database breach yields ' +
      'nothing that can forge a request. Not personal data.',
    accessControl: 'atl_app may read and stamp last_used_at.',
    countQuery: 'SELECT count(*)::bigint AS count FROM agent_credentials',
    isPersonalData: false,
  },
];

export interface DpdpGap {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly plannedIn: string;
}

/**
 * What is missing. Named, specific, and not softened.
 *
 * A privacy register whose "gaps" section is empty is a register nobody read
 * carefully.
 */
export const DPDP_GAPS: readonly DpdpGap[] = [
  {
    id: 'DP-GAP-01',
    title: 'No consent withdrawal mechanism',
    detail:
      'Consent is recorded but cannot be withdrawn. A mandate can be revoked, ' +
      'which ends an authority - it is not the same as withdrawing consent, ' +
      'which is a DPDP right with its own record, timing and downstream ' +
      'deletion obligations.',
    plannedIn: 'post-MVP',
  },
  {
    id: 'DP-GAP-02',
    title: 'No automated retention or deletion',
    detail:
      'Retention periods are stated in this register and enforced by nothing. ' +
      'No job deletes or archives anything, and the evidence tables are ' +
      'append-only by design, which makes deletion a genuinely hard design ' +
      'problem rather than a missing cron entry.',
    plannedIn: 'post-MVP',
  },
  {
    id: 'DP-GAP-03',
    title: 'No data subject access or portability endpoint',
    detail:
      'A user cannot request a copy of their data through the system. The data ' +
      'is queryable, but there is no self-service route and no identity ' +
      'verification flow for such a request.',
    plannedIn: 'post-MVP',
  },
  {
    id: 'DP-GAP-04',
    title: 'No encryption at rest beyond the filesystem',
    detail:
      'PostgreSQL runs locally with no column-level or tablespace encryption. ' +
      'A managed deployment would provide volume encryption; column-level ' +
      'encryption for the few sensitive fields is not implemented.',
    plannedIn: 'Phase 9 deployment',
  },
  {
    id: 'DP-GAP-05',
    title: 'No Consent Manager registration',
    detail:
      'The DPDP Rules provide for registered Consent Managers, with ' +
      'registration obligations landing 13 Nov 2026. We are not registered and ' +
      'do not integrate with one.',
    plannedIn: 'out of scope for the MVP',
  },
  {
    id: 'DP-GAP-06',
    title: 'No breach notification workflow',
    detail:
      'There is no defined process or tooling for notifying the Data Protection ' +
      'Board or affected users of a personal data breach.',
    plannedIn: 'organisational, not software',
  },
];

export const DPDP_CAVEAT =
  'PRIVACY CONTROL COVERAGE, NOT A COMPLIANCE CLAIM. This register states what ' +
  'personal data the system holds, why, and what protects it. It does not ' +
  'assert compliance with the Digital Personal Data Protection Act or the DPDP ' +
  'Rules 2025. Those obligations are PHASED: the Data Protection Board took ' +
  'effect on notification (13 Nov 2025), Consent Manager registration and ' +
  'penalties on 13 Nov 2026, and the full notice, consent, security and rights ' +
  'obligations on 13 May 2027. No merchant is non-compliant today for lacking ' +
  'these controls. The gaps listed here are real and are not softened.';

export interface DpdpRegisterReport {
  readonly kind: 'dpdp_register';
  readonly generatedAt: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly records: readonly (Omit<ProcessingRecord, 'countQuery'> & {
    readonly recordCount: number | null;
  })[];
  readonly personalDataCategories: number;
  readonly controlsInPlace: number;
  readonly gaps: readonly DpdpGap[];
  /** "8/14" - controls in place over controls in place plus gaps. */
  readonly privacyControlCoverage: string;
  readonly caveat: string;
}

export async function buildDpdpRegister(
  client: pg.PoolClient | pg.Pool,
  options: { periodStart?: Date; periodEnd?: Date; now?: Date } = {},
): Promise<DpdpRegisterReport> {
  const now = options.now ?? new Date();
  const periodEnd = options.periodEnd ?? now;
  const periodStart =
    options.periodStart ?? new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000);

  const records = [];

  for (const record of PROCESSING_RECORDS) {
    const { countQuery, ...rest } = record;
    let recordCount: number | null = null;

    if (countQuery !== null) {
      try {
        const result = await client.query<{ count: string }>(countQuery);
        recordCount = Number(result.rows[0]?.count ?? 0);
      } catch {
        // A count we cannot take is reported as unknown, never as zero. Zero
        // would read as "we hold none of this", which is a much stronger and
        // possibly false statement.
        recordCount = null;
      }
    }

    records.push({ ...rest, recordCount });
  }

  const controlsInPlace = PROCESSING_RECORDS.length;

  return {
    kind: 'dpdp_register',
    generatedAt: now.toISOString(),
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    records,
    personalDataCategories: PROCESSING_RECORDS.filter((r) => r.isPersonalData).length,
    controlsInPlace,
    gaps: DPDP_GAPS,
    privacyControlCoverage: `${controlsInPlace}/${controlsInPlace + DPDP_GAPS.length}`,
    caveat: DPDP_CAVEAT,
  };
}
