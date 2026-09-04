/**
 * Agent credential lookup - the read that authenticates every signed request.
 */
import type pg from 'pg';

export interface CredentialRecord {
  readonly credentialId: string;
  readonly agentId: string;
  readonly keyId: string;
  readonly publicKeySpkiB64: string;
  readonly fingerprint: string;
  readonly credentialStatus: string;
  readonly agentStatus: string;
  readonly expiresAt: Date | null;
}

/**
 * Find a credential by its public key id.
 *
 * Returns the row WHATEVER its status, and joins the agent's status too, so the
 * caller can tell "no such key" apart from "revoked key" apart from "suspended
 * agent". All three produce the same 401 to the outside world, but they are
 * very different lines in our own logs - and an operator investigating an
 * incident needs to know which one happened.
 *
 * `agents` is an INNER JOIN because a credential without an agent cannot exist:
 * agent_id is NOT NULL with a foreign key.
 */
export async function findCredentialByKeyId(
  client: pg.PoolClient | pg.Pool,
  keyId: string,
): Promise<CredentialRecord | null> {
  const result = await client.query<{
    id: string;
    agent_id: string;
    key_id: string;
    public_key_spki_b64: string;
    public_key_fingerprint: string;
    status: string;
    agent_status: string;
    expires_at: Date | null;
  }>(
    `SELECT c.id, c.agent_id, c.key_id, c.public_key_spki_b64, c.public_key_fingerprint,
            c.status, c.expires_at, a.status AS agent_status
       FROM agent_credentials c
       JOIN agents a ON a.id = c.agent_id
      WHERE c.key_id = $1`,
    [keyId],
  );

  const row = result.rows[0];
  if (row === undefined) return null;

  return {
    credentialId: row.id,
    agentId: row.agent_id,
    keyId: row.key_id,
    publicKeySpkiB64: row.public_key_spki_b64,
    fingerprint: row.public_key_fingerprint,
    credentialStatus: row.status,
    agentStatus: row.agent_status,
    expiresAt: row.expires_at,
  };
}

/**
 * Stamp last_used_at.
 *
 * Operationally useful in two opposite directions: a credential nobody has used
 * for months should be revoked, and a credential suddenly used after months of
 * silence should be investigated.
 *
 * Deliberately NOT inside the caller's authorization transaction. It is
 * telemetry, not evidence - and taking a write lock on the credential row on
 * every request would serialise all of one agent's traffic for no security
 * benefit. A failure here must never fail a payment, so the caller ignores it.
 */
export async function touchCredential(
  client: pg.PoolClient | pg.Pool,
  credentialId: string,
): Promise<void> {
  await client.query(`UPDATE agent_credentials SET last_used_at = now() WHERE id = $1`, [
    credentialId,
  ]);
}
