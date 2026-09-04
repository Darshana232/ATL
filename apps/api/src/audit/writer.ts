/**
 * Appending to the audit trail.
 *
 * WHAT GETS HASHED, AND WHY IT IS NOT JUST THE PAYLOAD.
 *
 * The naive design hashes `payload` alone. That leaves every other column
 * editable without breaking the chain - someone could change `occurred_at`,
 * `actor_id` or `subject_id` and the chain would still verify. Those are
 * exactly the fields an investigation cares about ("who did this, and when?").
 *
 * So the hash covers the whole logical record:
 *
 *   payload_hash = sha256(canonicalJson(payload))
 *   hash         = sha256(canonicalJson({
 *                    v, chainId, id, eventType, occurredAt, actorKind,
 *                    actorId, subjectKind, subjectId, requestId, mandateId,
 *                    payloadHash, prevHash
 *                  }))
 *
 * Three consequences worth noticing:
 *   - `prevHash` is INSIDE the hashed record, so each row commits to its
 *     predecessor. Altering any earlier row breaks every hash after it.
 *   - `chainId` is inside it too, so a row cannot be moved between chains.
 *   - `v` is the hashing-scheme version, so a future change to the scheme is
 *     explicit and old rows stay verifiable under the scheme that made them.
 *
 * `occurredAt` is generated HERE rather than by a database default,
 * specifically so it can be hashed. A DB default would be unknown to us at
 * hash time and therefore unprotected.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { hashCanonical, type CanonicalValue } from './canonical.js';

/** Bumped only if the hashing scheme itself changes. */
export const AUDIT_HASH_SCHEME_VERSION = 1;

export const DEFAULT_CHAIN_ID = 'main';

export type ActorKind = 'user' | 'agent' | 'system' | 'admin';

export type SubjectKind =
  | 'mandate'
  | 'mandate_version'
  | 'agent'
  | 'user'
  | 'authorization_request'
  | 'decision'
  | 'payment'
  | 'report'
  | 'audit';

export interface AuditEventInput {
  readonly eventType: string;
  readonly actorKind: ActorKind;
  /** Required unless actorKind is 'system' - enforced by the database too. */
  readonly actorId: string | null;
  readonly subjectKind: SubjectKind;
  readonly subjectId: string;
  /** Ties this evidence row to the application logs for the same request. */
  readonly requestId?: string | null;
  readonly mandateId?: string | null;
  /**
   * The self-contained snapshot being attested.
   *
   * SELF-CONTAINED MATTERS: verifying a hash must not require joining to other
   * tables, because those tables may themselves have changed since. This is
   * the one place we deliberately duplicate data that lives elsewhere.
   *
   * Built from an explicit allowlist of fields by the caller, never by
   * spreading a request object - an allowlist fails closed, so a newly added
   * field stays out of the audit trail until someone puts it there
   * deliberately.
   */
  readonly payload: Readonly<Record<string, CanonicalValue>>;
  readonly chainId?: string;
  /** Overridable only for tests; production always uses "now". */
  readonly occurredAt?: Date;
}

/** Exactly the fields covered by `hash`, in the shape that gets canonicalised. */
export interface HashableAuditRecord {
  readonly v: number;
  readonly chainId: string;
  readonly id: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly requestId: string | null;
  readonly mandateId: string | null;
  readonly payloadHash: string;
  readonly prevHash: string | null;
}

export interface AppendedAuditEvent {
  readonly id: string;
  readonly seq: number;
  readonly chainId: string;
  readonly hash: string;
  readonly prevHash: string | null;
  readonly payloadHash: string;
  readonly occurredAt: Date;
}

/**
 * The single definition of an event's hash.
 *
 * Exported because Phase 6's verifier MUST use this exact function. Two
 * implementations of "how we hash a record" would eventually disagree, and the
 * disagreement would look like tampering.
 */
export function computeEventHash(record: HashableAuditRecord): string {
  return hashCanonical(record as unknown as CanonicalValue);
}

export function newAuditEventId(): string {
  // 12 random bytes -> 24 lowercase hex chars, satisfying
  // CHECK (id ~ '^evt_[a-z0-9_]{2,40}$').
  return `evt_${randomBytes(12).toString('hex')}`;
}

/** The most recent event's hash for a chain, or null if the chain is empty. */
export async function readChainHead(
  txClient: pg.PoolClient,
  chainId: string = DEFAULT_CHAIN_ID,
): Promise<string | null> {
  const result = await txClient.query<{ hash: string }>(
    `SELECT hash FROM audit_events WHERE chain_id = $1 ORDER BY seq DESC LIMIT 1`,
    [chainId],
  );

  return result.rows[0]?.hash ?? null;
}

/**
 * Append one event to a chain.
 *
 * MUST BE CALLED INSIDE A TRANSACTION that the caller controls, for two
 * reasons:
 *
 *   1. `pg_advisory_xact_lock` is released at COMMIT. Outside a transaction
 *      each statement commits immediately, so the lock would be released
 *      before the INSERT and the serialisation would be lost.
 *   2. The audit event and the thing it describes must land together. An event
 *      recording a mandate that was never created - or a mandate with no event
 *      - is worse than either alone.
 *
 * The lock exists because appending is INHERENTLY SERIAL: two concurrent
 * appends would read the same head, compute the same `prev_hash`, and the
 * `audit_events_no_fork_idx` unique index would reject one of them. A lock
 * turns a hard failure into a short wait, and avoids a retry loop - retry
 * loops are where concurrency bugs live.
 */
export async function appendAuditEvent(
  txClient: pg.PoolClient,
  input: AuditEventInput,
): Promise<AppendedAuditEvent> {
  const chainId = input.chainId ?? DEFAULT_CHAIN_ID;

  // Serialise appends to THIS chain. Different chains do not contend, which
  // is the escape hatch when one chain's throughput becomes the bottleneck
  // (see PHASE_03 §9).
  await txClient.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [chainId]);

  const prevHash = await readChainHead(txClient, chainId);

  const id = newAuditEventId();
  const occurredAt = input.occurredAt ?? new Date();
  const payloadHash = hashCanonical(input.payload as CanonicalValue);

  const hashable: HashableAuditRecord = {
    v: AUDIT_HASH_SCHEME_VERSION,
    chainId,
    id,
    eventType: input.eventType,
    occurredAt: occurredAt.toISOString(),
    actorKind: input.actorKind,
    actorId: input.actorId,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    requestId: input.requestId ?? null,
    mandateId: input.mandateId ?? null,
    payloadHash,
    prevHash,
  };

  const hash = computeEventHash(hashable);

  const inserted = await txClient.query<{ seq: number }>(
    `INSERT INTO audit_events
       (id, chain_id, event_type, occurred_at, actor_kind, actor_id,
        subject_kind, subject_id, request_id, mandate_id,
        payload, payload_hash, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING seq`,
    [
      id,
      chainId,
      input.eventType,
      occurredAt.toISOString(),
      input.actorKind,
      input.actorId,
      input.subjectKind,
      input.subjectId,
      input.requestId ?? null,
      input.mandateId ?? null,
      // Stored as JSONB for querying. The HASH is over our canonical
      // serialisation, not over whatever bytes Postgres chooses to store -
      // JSONB normalises key order and whitespace, so hashing the stored form
      // would be hashing something we do not control.
      JSON.stringify(input.payload),
      payloadHash,
      prevHash,
      hash,
    ],
  );

  const seq = inserted.rows[0]?.seq;
  if (seq === undefined) {
    // Cannot happen with RETURNING on a successful insert, but an audit writer
    // that silently returns a bogus result is worse than one that throws.
    throw new Error('audit insert returned no sequence number');
  }

  return { id, seq, chainId, hash, prevHash, payloadHash, occurredAt };
}
