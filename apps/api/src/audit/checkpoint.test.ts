/**
 * Checkpoint signing.
 *
 * The checkpoint is the only thing standing between us and an attacker who
 * rewrites the entire chain consistently. Every test names what it prevents.
 */
import { describe, expect, it } from 'vitest';
import { signCheckpoint, verifyCheckpointSignature, type CheckpointFacts } from './checkpoint.js';

const SECRET = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const facts: CheckpointFacts = {
  chainId: 'main',
  seq: 4_211,
  headHash: 'd'.repeat(64),
  eventCount: 4_211,
  createdAt: '2026-09-05T12:00:00.000Z',
};

describe('signing', () => {
  it('is deterministic for the same facts', () => {
    expect(signCheckpoint(SECRET, facts)).toBe(signCheckpoint(SECRET, facts));
  });

  it('does not depend on key order in the facts object', () => {
    // canonicalJson sorts keys. Without that, the signature would depend on how
    // the object happened to be constructed, and a harmless refactor would
    // invalidate every historical anchor.
    const reordered = {
      createdAt: facts.createdAt, eventCount: facts.eventCount,
      headHash: facts.headHash, seq: facts.seq, chainId: facts.chainId,
    } as CheckpointFacts;

    expect(signCheckpoint(SECRET, reordered)).toBe(signCheckpoint(SECRET, facts));
  });

  it('produces 64 hex characters, satisfying the table constraint', () => {
    expect(signCheckpoint(SECRET, facts)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verification rejects every alteration', () => {
  const signature = signCheckpoint(SECRET, facts);

  it('accepts the genuine signature', () => {
    expect(verifyCheckpointSignature(SECRET, facts, signature)).toBe(true);
  });

  it('rejects a moved head hash', () => {
    // PREVENTS: rewriting the chain and re-pointing the anchor at the new head.
    expect(verifyCheckpointSignature(SECRET, { ...facts, headHash: 'e'.repeat(64) }, signature))
      .toBe(false);
  });

  it('rejects a moved sequence position', () => {
    expect(verifyCheckpointSignature(SECRET, { ...facts, seq: 4_212 }, signature)).toBe(false);
  });

  it('rejects an altered event count', () => {
    // PREVENTS: dropping inconvenient events and renumbering. Even if the
    // hashes are made internally consistent, the COUNT changes.
    expect(verifyCheckpointSignature(SECRET, { ...facts, eventCount: 4_000 }, signature))
      .toBe(false);
  });

  it('rejects a back-dated anchor', () => {
    // PREVENTS: claiming an anchor is older than it is, to cover a rewrite that
    // happened after it. The date is inside the signature for exactly this.
    expect(
      verifyCheckpointSignature(SECRET, { ...facts, createdAt: '2020-01-01T00:00:00.000Z' }, signature),
    ).toBe(false);
  });

  it('rejects a different chain id', () => {
    expect(verifyCheckpointSignature(SECRET, { ...facts, chainId: 'other' }, signature)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    // KEY SEPARATION: the voucher secret must not be able to sign history.
    expect(verifyCheckpointSignature(OTHER, facts, signature)).toBe(false);
    expect(verifyCheckpointSignature(SECRET, facts, signCheckpoint(OTHER, facts))).toBe(false);
  });

  it('returns false rather than throwing on malformed input', () => {
    // A security check whose outcome depends on the caller's catch block is not
    // a security check.
    for (const bad of ['', 'zz', 'not-hex-at-all', 'a'.repeat(63), 'a'.repeat(128)]) {
      expect(verifyCheckpointSignature(SECRET, facts, bad), bad).toBe(false);
    }
  });
});
