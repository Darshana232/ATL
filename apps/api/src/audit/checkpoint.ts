/**
 * Signed checkpoints over the audit hash chain.
 *
 * THE GAP THIS FILLS. The chain detects a SINGLE edit: change one row and every
 * hash after it stops matching. It does NOT detect a CONSISTENT REWRITE -
 * someone with superuser rights can recompute every row and every hash, and the
 * result verifies perfectly, because a chain only proves internal consistency.
 *
 * A checkpoint records "at seq N, on this date, the head hash was H", signed
 * with a secret that is not in the database. Faking history before a checkpoint
 * now requires forging that signature too.
 *
 * THE HONEST LIMIT, and it is repeated everywhere this feature is described:
 * this raises the bar from "can write to the database" to "can write to the
 * database AND exfiltrate a secret". It does not make the trail tamper-PROOF.
 * Only anchoring the head hash somewhere we do not control - a public
 * transparency log, a counterparty, a published notice - does that, and that
 * needs a counterparty an MVP does not have.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './canonical.js';

export const CHECKPOINT_ALGORITHM = 'hmac-sha256';

export interface CheckpointFacts {
  readonly chainId: string;
  readonly seq: number;
  readonly headHash: string;
  readonly eventCount: number;
  /** ISO-8601. Part of the signature, so the anchor's DATE cannot be moved. */
  readonly createdAt: string;
}

/**
 * The signature covers every fact, canonically serialised.
 *
 * `canonicalJson` rather than string concatenation: the same reason the event
 * hash uses it. Concatenation reintroduces field-splitting ambiguity, and key
 * order would make the signature depend on how the object happened to be built.
 */
export function signCheckpoint(secret: string, facts: CheckpointFacts): string {
  return createHmac('sha256', secret)
    .update(canonicalJson({ v: 1, ...facts }))
    .digest('hex');
}

/**
 * Constant-time verification. Returns a boolean; never throws.
 *
 * A plain `===` on hex strings short-circuits at the first differing character,
 * so how long it takes reveals how many leading characters were correct. That
 * is a real attack against a signature an attacker can submit repeatedly.
 */
export function verifyCheckpointSignature(
  secret: string,
  facts: CheckpointFacts,
  signature: string,
): boolean {
  try {
    const expected = Buffer.from(signCheckpoint(secret, facts), 'hex');
    const provided = Buffer.from(signature, 'hex');

    // timingSafeEqual THROWS on a length mismatch, and a wrong length is
    // already a definitive failure, so it is checked first.
    if (provided.length !== expected.length) return false;

    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}
