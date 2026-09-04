/**
 * Reads over the audit chain, and checkpoint persistence.
 *
 * The verification read is a CURSOR, not a SELECT into an array. Verifying a
 * ten-million-event chain by loading it into memory is an out-of-memory error
 * waiting for a Tuesday - and this is exactly the code that must still work on
 * the day somebody actually needs it.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { DEFAULT_CHAIN_ID } from '../audit/writer.js';
import type { CheckpointFacts } from '../audit/checkpoint.js';

export const newCheckpointId = (): string => `ckpt_${randomBytes(10).toString('hex')}`;

/** One row, in the shape the verifier needs to recompute its hash. */
export interface ChainRow {
  readonly seq: number;
  readonly id: string;
  readonly chainId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly requestId: string | null;
  readonly mandateId: string | null;
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly prevHash: string | null;
  readonly hash: string;
}

const CHAIN_COLUMNS = `
  seq, id, chain_id, event_type, occurred_at, actor_kind, actor_id,
  subject_kind, subject_id, request_id, mandate_id,
  payload, payload_hash, prev_hash, hash
`;

interface RawChainRow {
  seq: string | number; id: string; chain_id: string; event_type: string;
  occurred_at: Date; actor_kind: string; actor_id: string | null;
  subject_kind: string; subject_id: string; request_id: string | null;
  mandate_id: string | null; payload: unknown; payload_hash: string;
  prev_hash: string | null; hash: string;
}

function toChainRow(row: RawChainRow): ChainRow {
  return {
    seq: Number(row.seq),
    id: row.id,
    chainId: row.chain_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    requestId: row.request_id,
    mandateId: row.mandate_id,
    payload: row.payload,
    payloadHash: row.payload_hash,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

/**
 * Stream a chain in `seq` order, one page at a time.
 *
 * KEYSET PAGINATION (`seq > lastSeen`), not OFFSET. OFFSET makes the database
 * scan and discard every earlier row on each page, so page 10,000 costs ten
 * thousand pages of work - the classic accidental O(n^2) in a "streaming" loop.
 * It is also unstable when rows are inserted concurrently, and this table is
 * append-only, so insertion during a long verification is normal.
 *
 * `fromSeq` lets verification start at the last checkpoint instead of at
 * genesis, which is the main performance reason checkpoints earn their place.
 */
export async function* streamChain(
  client: pg.PoolClient | pg.Pool,
  chainId: string = DEFAULT_CHAIN_ID,
  options: { fromSeq?: number; pageSize?: number } = {},
): AsyncGenerator<ChainRow> {
  const pageSize = options.pageSize ?? 500;
  let after = (options.fromSeq ?? 1) - 1;

  for (;;) {
    const page = await client.query<RawChainRow>(
      `SELECT ${CHAIN_COLUMNS}
         FROM audit_events
        WHERE chain_id = $1 AND seq > $2
        ORDER BY seq
        LIMIT $3`,
      [chainId, after, pageSize],
    );

    if (page.rows.length === 0) return;

    for (const row of page.rows) {
      const mapped = toChainRow(row);
      after = mapped.seq;
      yield mapped;
    }

    // A short page means we reached the end. Saves one empty round trip.
    if (page.rows.length < pageSize) return;
  }
}

export interface ChainSummary {
  readonly eventCount: number;
  readonly headSeq: number | null;
  readonly headHash: string | null;
  readonly genesisCount: number;
}

/**
 * Chain shape in one query.
 *
 * `genesisCount` is read even though a unique index already guarantees it is at
 * most one. The index protects against the APPLICATION creating a second
 * genesis; it does not protect against someone with owner rights dropping the
 * index. Verification should not assume the constraint it is verifying.
 */
export async function summariseChain(
  client: pg.PoolClient | pg.Pool,
  chainId: string = DEFAULT_CHAIN_ID,
): Promise<ChainSummary> {
  const result = await client.query<{
    event_count: string; head_seq: string | null;
    head_hash: string | null; genesis_count: string;
  }>(
    `SELECT count(*)::bigint                                   AS event_count,
            max(seq)::bigint                                   AS head_seq,
            (SELECT hash FROM audit_events
              WHERE chain_id = $1 ORDER BY seq DESC LIMIT 1)    AS head_hash,
            count(*) FILTER (WHERE prev_hash IS NULL)::bigint   AS genesis_count
       FROM audit_events
      WHERE chain_id = $1`,
    [chainId],
  );

  const row = result.rows[0];

  return {
    eventCount: Number(row?.event_count ?? 0),
    headSeq: row?.head_seq === null || row?.head_seq === undefined ? null : Number(row.head_seq),
    headHash: row?.head_hash ?? null,
    genesisCount: Number(row?.genesis_count ?? 0),
  };
}

export interface StoredCheckpoint extends CheckpointFacts {
  readonly id: string;
  readonly signature: string;
  readonly createdBy: string;
}

interface RawCheckpointRow {
  id: string; chain_id: string; seq: string | number; head_hash: string;
  event_count: string | number; signature: string; created_by: string; created_at: Date;
}

function toCheckpoint(row: RawCheckpointRow): StoredCheckpoint {
  return {
    id: row.id,
    chainId: row.chain_id,
    seq: Number(row.seq),
    headHash: row.head_hash,
    eventCount: Number(row.event_count),
    signature: row.signature,
    createdBy: row.created_by,
    // Serialised the same way it was signed. A Date rendered any other way
    // would produce different bytes and a false signature failure.
    createdAt: row.created_at.toISOString(),
  };
}

/** Every checkpoint for a chain, oldest first. */
export async function listCheckpoints(
  client: pg.PoolClient | pg.Pool,
  chainId: string = DEFAULT_CHAIN_ID,
): Promise<StoredCheckpoint[]> {
  const result = await client.query<RawCheckpointRow>(
    `SELECT id, chain_id, seq, head_hash, event_count, signature, created_by, created_at
       FROM audit_checkpoints
      WHERE chain_id = $1
      ORDER BY seq`,
    [chainId],
  );

  return result.rows.map(toCheckpoint);
}

export async function latestCheckpoint(
  client: pg.PoolClient | pg.Pool,
  chainId: string = DEFAULT_CHAIN_ID,
): Promise<StoredCheckpoint | null> {
  const result = await client.query<RawCheckpointRow>(
    `SELECT id, chain_id, seq, head_hash, event_count, signature, created_by, created_at
       FROM audit_checkpoints
      WHERE chain_id = $1
      ORDER BY seq DESC
      LIMIT 1`,
    [chainId],
  );

  const row = result.rows[0];
  return row === undefined ? null : toCheckpoint(row);
}

export async function insertCheckpoint(
  txClient: pg.PoolClient,
  checkpoint: StoredCheckpoint,
): Promise<void> {
  await txClient.query(
    `INSERT INTO audit_checkpoints
       (id, chain_id, seq, head_hash, event_count, signature, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      checkpoint.id, checkpoint.chainId, checkpoint.seq, checkpoint.headHash,
      checkpoint.eventCount, checkpoint.signature, checkpoint.createdBy,
      checkpoint.createdAt,
    ],
  );
}

/** The audit-trail reading endpoint. Newest first, keyset-paginated. */
export async function listEvents(
  client: pg.PoolClient | pg.Pool,
  options: {
    chainId?: string;
    mandateId?: string | null;
    eventType?: string | null;
    beforeSeq?: number | null;
    limit?: number;
  } = {},
): Promise<ChainRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  const result = await client.query<RawChainRow>(
    `SELECT ${CHAIN_COLUMNS}
       FROM audit_events
      WHERE chain_id = $1
        AND ($2::text IS NULL OR mandate_id = $2)
        AND ($3::text IS NULL OR event_type = $3)
        AND ($4::bigint IS NULL OR seq < $4)
      ORDER BY seq DESC
      LIMIT $5`,
    [
      options.chainId ?? DEFAULT_CHAIN_ID,
      options.mandateId ?? null,
      options.eventType ?? null,
      options.beforeSeq ?? null,
      limit,
    ],
  );

  return result.rows.map(toChainRow);
}
