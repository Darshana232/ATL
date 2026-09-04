/**
 * Chain verification.
 *
 * "Tamper-evident" is a CLAIM until something exists that fails when it stops
 * being true. This file is that something.
 *
 * IT IMPORTS `computeEventHash` FROM THE WRITER. It does not reimplement it.
 * Two implementations of "how we hash a record" would eventually disagree about
 * some edge case, and the disagreement would look EXACTLY like tampering - the
 * worst possible false positive for a feature whose entire job is to be
 * believed. `computeEventHash` has been exported since Phase 3 for this reason.
 */
import type pg from 'pg';
import { computeEventHash, AUDIT_HASH_SCHEME_VERSION, DEFAULT_CHAIN_ID } from './writer.js';
import { hashCanonical, type CanonicalValue } from './canonical.js';
import { verifyCheckpointSignature } from './checkpoint.js';
import {
  listCheckpoints,
  streamChain,
  summariseChain,
  type ChainRow,
  type StoredCheckpoint,
} from '../repositories/audit.js';

/** What kind of damage we found. Each maps to a specific attack. */
export type BreakKind =
  | 'payload_hash_mismatch'   // the payload was edited
  | 'event_hash_mismatch'     // any hashed field was edited (actor, time, ...)
  | 'broken_link'             // prev_hash does not match the previous row
  | 'unexpected_genesis'      // a second chain start, spliced in
  | 'missing_genesis';        // the real first event was removed

export interface ChainBreak {
  readonly seq: number;
  readonly eventId: string;
  readonly kind: BreakKind;
  readonly detail: string;
}

/**
 * `unreachable` means WE COULD NOT CHECK (no secret configured). It never means
 * "the anchor is fine".
 *
 * An earlier version also returned it when the anchored event was missing,
 * which meant DELETING THE ENTIRE CHAIN reported `intact` - the single worst
 * false negative this feature could have. Caught by the full-rewrite test. A
 * missing anchored event is always `head_mismatch`: the chain no longer
 * contains what was signed for.
 */
export type CheckpointStatus = 'valid' | 'forged_signature' | 'head_mismatch' | 'unreachable';

export interface CheckpointResult {
  readonly id: string;
  readonly seq: number;
  readonly createdAt: string;
  readonly status: CheckpointStatus;
  readonly detail: string;
}

export interface VerificationResult {
  readonly chainId: string;
  readonly status: 'intact' | 'broken';
  readonly eventsChecked: number;
  readonly totalEvents: number;
  /**
   * ONLY THE FIRST BREAK.
   *
   * After one broken link every subsequent row also fails, so listing them all
   * would return a million lines describing a single edit. The first break is
   * the actionable fact, and `eventsChecked` says how far the chain was sound.
   */
  readonly firstBreak: ChainBreak | null;
  readonly headHash: string | null;
  readonly checkpoints: readonly CheckpointResult[];
  readonly verifiedAt: string;
  /** The claim ceiling, carried in the response itself. Never dropped. */
  readonly limitation: string;
}

export const TAMPER_EVIDENT_NOTICE =
  'TAMPER-EVIDENT, NOT TAMPER-PROOF. A hash chain detects modification; it ' +
  'does not prevent it. An attacker holding both database superuser rights ' +
  'and the checkpoint signing secret could rewrite history undetectably. ' +
  'Anchoring the head hash outside our control is the fix, and it is not in ' +
  'this MVP.';

/**
 * Recompute one row's hashes and compare them to what is stored.
 *
 * Returns the FIRST problem found, or null. Order matters for the explanation:
 * a payload edit is reported as a payload edit rather than as a generic event
 * hash mismatch, because "someone changed the amount" and "someone changed the
 * actor" send an investigator to different places.
 */
export function checkRow(row: ChainRow, previous: ChainRow | null): ChainBreak | null {
  const recomputedPayloadHash = hashCanonical(row.payload as CanonicalValue);

  if (recomputedPayloadHash !== row.payloadHash) {
    return {
      seq: row.seq,
      eventId: row.id,
      kind: 'payload_hash_mismatch',
      detail:
        `The stored payload does not hash to payload_hash. Recorded ` +
        `${row.payloadHash.slice(0, 16)}…, recomputed ${recomputedPayloadHash.slice(0, 16)}…`,
    };
  }

  const recomputedHash = computeEventHash({
    v: AUDIT_HASH_SCHEME_VERSION,
    chainId: row.chainId,
    id: row.id,
    eventType: row.eventType,
    occurredAt: row.occurredAt.toISOString(),
    actorKind: row.actorKind,
    actorId: row.actorId,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    requestId: row.requestId,
    mandateId: row.mandateId,
    payloadHash: row.payloadHash,
    prevHash: row.prevHash,
  });

  if (recomputedHash !== row.hash) {
    return {
      seq: row.seq,
      eventId: row.id,
      kind: 'event_hash_mismatch',
      detail:
        `A hashed field of this event was altered. The hash covers the WHOLE ` +
        `record - event type, actor, subject, timestamp and payload hash - so ` +
        `this catches an edited actor_id just as well as an edited amount. ` +
        `Recorded ${row.hash.slice(0, 16)}…, recomputed ${recomputedHash.slice(0, 16)}…`,
    };
  }

  if (previous === null) {
    // The first row we examined. It may legitimately be genesis, or the row at
    // a checkpoint we resumed from - the caller decides which.
    return null;
  }

  if (row.prevHash === null) {
    return {
      seq: row.seq,
      eventId: row.id,
      kind: 'unexpected_genesis',
      detail:
        `This event claims to start a chain, but ${previous.seq} precedes it. ` +
        `A second genesis is how a forged history gets spliced in.`,
    };
  }

  if (row.prevHash !== previous.hash) {
    return {
      seq: row.seq,
      eventId: row.id,
      kind: 'broken_link',
      detail:
        `prev_hash points at ${row.prevHash.slice(0, 16)}… but event ${previous.seq} ` +
        `hashes to ${previous.hash.slice(0, 16)}…. Either an earlier event was ` +
        `edited and re-hashed, or one was removed.`,
    };
  }

  return null;
}

function checkOneCheckpoint(
  checkpoint: StoredCheckpoint,
  secret: string | undefined,
  hashAtSeq: Map<number, string>,
  headSeq: number | null,
): CheckpointResult {
  const base = { id: checkpoint.id, seq: checkpoint.seq, createdAt: checkpoint.createdAt };

  if (secret === undefined) {
    return {
      ...base,
      status: 'unreachable',
      detail: 'AUDIT_CHECKPOINT_SECRET is not configured, so this anchor cannot be checked.',
    };
  }

  const facts = {
    chainId: checkpoint.chainId,
    seq: checkpoint.seq,
    headHash: checkpoint.headHash,
    eventCount: checkpoint.eventCount,
    createdAt: checkpoint.createdAt,
  };

  // SIGNATURE FIRST, then content. Comparing the recorded head hash to the
  // chain before verifying the signature would mean trusting an unverified
  // value - the same "authenticate first, interpret second" rule as the
  // request signature and the voucher.
  if (!verifyCheckpointSignature(secret, facts, checkpoint.signature)) {
    return {
      ...base,
      status: 'forged_signature',
      detail:
        'This checkpoint was altered or signed with a different key. Its ' +
        'claim about history cannot be relied on.',
    };
  }

  const actual = hashAtSeq.get(checkpoint.seq);

  if (actual === undefined) {
    return {
      ...base,
      status: 'head_mismatch',
      detail:
        `No event exists at seq ${checkpoint.seq}, but this signed anchor says ` +
        `one did. The chain is shorter than the anchor claims: history was ` +
        `truncated or removed` +
        `${headSeq === null ? ' (the chain is now empty)' : `, and now ends at seq ${headSeq}`}.`,
    };
  }

  if (actual !== checkpoint.headHash) {
    return {
      ...base,
      status: 'head_mismatch',
      detail:
        `At seq ${checkpoint.seq} the chain now heads at ${actual.slice(0, 16)}… ` +
        `but this signed anchor recorded ${checkpoint.headHash.slice(0, 16)}…. ` +
        `The chain was rewritten CONSISTENTLY - which the chain alone cannot ` +
        `detect, and which is exactly what checkpoints exist for.`,
    };
  }

  return { ...base, status: 'valid', detail: 'Anchor signature and head hash both match.' };
}

export interface VerifyOptions {
  readonly chainId?: string;
  /** Absent means checkpoints are reported as `unreachable`, not as valid. */
  readonly checkpointSecret?: string;
  readonly now?: Date;
}

/**
 * Walk a chain and prove - or disprove - its integrity.
 *
 * STREAMING. Rows arrive one page at a time and only two are ever held: the
 * current one and its predecessor. That is what makes this work on a chain
 * larger than memory, which is the only size at which the feature matters.
 */
export async function verifyChain(
  client: pg.PoolClient | pg.Pool,
  options: VerifyOptions = {},
): Promise<VerificationResult> {
  const chainId = options.chainId ?? DEFAULT_CHAIN_ID;
  const summary = await summariseChain(client, chainId);

  let previous: ChainRow | null = null;
  let checked = 0;
  let firstBreak: ChainBreak | null = null;

  /**
   * Only the hashes a checkpoint actually anchors are retained.
   *
   * Keeping every hash would defeat the streaming design on exactly the chains
   * where streaming matters. There are a handful of checkpoints; there are
   * millions of events.
   */
  const checkpoints = await listCheckpoints(client, chainId);
  const anchoredSeqs = new Set(checkpoints.map((c) => c.seq));
  const hashAtSeq = new Map<number, string>();

  for await (const row of streamChain(client, chainId)) {
    if (anchoredSeqs.has(row.seq)) hashAtSeq.set(row.seq, row.hash);

    if (firstBreak === null) {
      // The very first row of a chain must be genesis. Anything else means the
      // original first event was removed.
      if (previous === null && row.prevHash !== null) {
        firstBreak = {
          seq: row.seq,
          eventId: row.id,
          kind: 'missing_genesis',
          detail:
            `The earliest event in this chain points at a predecessor that is ` +
            `not present. The chain's first event was removed.`,
        };
      } else {
        firstBreak = checkRow(row, previous);
      }

      if (firstBreak === null) checked += 1;
    }

    previous = row;
  }

  // Continue past a break rather than stopping, so the checkpoint hashes are
  // still collected - a broken chain is exactly when the anchors matter most.
  const checkpointResults = checkpoints.map((checkpoint) =>
    checkOneCheckpoint(checkpoint, options.checkpointSecret, hashAtSeq, summary.headSeq),
  );

  if (firstBreak === null && summary.genesisCount > 1) {
    firstBreak = {
      seq: 0,
      eventId: '(chain)',
      kind: 'unexpected_genesis',
      detail:
        `${summary.genesisCount} events claim to start this chain. Exactly one ` +
        `may. A second genesis is how a parallel forged history is introduced.`,
    };
  }

  const checkpointsBroken = checkpointResults.some(
    (result) => result.status === 'forged_signature' || result.status === 'head_mismatch',
  );

  return {
    chainId,
    status: firstBreak === null && !checkpointsBroken ? 'intact' : 'broken',
    eventsChecked: checked,
    totalEvents: summary.eventCount,
    firstBreak,
    headHash: summary.headHash,
    checkpoints: checkpointResults,
    verifiedAt: (options.now ?? new Date()).toISOString(),
    limitation: TAMPER_EVIDENT_NOTICE,
  };
}
