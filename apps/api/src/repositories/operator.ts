/**
 * Operator accounts and sessions.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Role } from '../auth/session.js';

export const newOperatorId = (): string => `opr_${randomBytes(8).toString('hex')}`;
export const newSessionId = (): string => `ses_${randomBytes(10).toString('hex')}`;

export interface Operator {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly role: Role;
  readonly status: string;
  readonly failedLogins: number;
  readonly lockedUntil: Date | null;
}

interface RawOperator {
  id: string; email: string; display_name: string; password_hash: string;
  role: string; status: string; failed_logins: number; locked_until: Date | null;
}

const toOperator = (row: RawOperator): Operator => ({
  id: row.id, email: row.email, displayName: row.display_name,
  passwordHash: row.password_hash, role: row.role as Role, status: row.status,
  failedLogins: row.failed_logins, lockedUntil: row.locked_until,
});

export async function findOperatorByEmail(
  client: pg.PoolClient | pg.Pool,
  email: string,
): Promise<Operator | null> {
  const result = await client.query<RawOperator>(
    `SELECT id, email, display_name, password_hash, role, status,
            failed_logins, locked_until
       FROM operators WHERE email = $1`,
    // Lowercased at the boundary so 'A@x.com' and 'a@x.com' are one account.
    [email.trim().toLowerCase()],
  );

  const row = result.rows[0];
  return row === undefined ? null : toOperator(row);
}

export async function insertOperator(
  client: pg.PoolClient | pg.Pool,
  params: {
    id: string; email: string; displayName: string;
    passwordHash: string; role: Role;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO operators (id, email, display_name, password_hash, role)
     VALUES ($1,$2,$3,$4,$5)`,
    [params.id, params.email.trim().toLowerCase(), params.displayName,
     params.passwordHash, params.role],
  );
}

/**
 * Record a failed login and lock the account after repeated failures.
 *
 * FIVE ATTEMPTS, then fifteen minutes. Lockout is a genuine trade: it stops
 * online guessing, and it also lets an attacker who knows an email address
 * deny that person access on purpose. Fifteen minutes is short enough that the
 * denial is an annoyance rather than an outage, and long enough that guessing
 * at scale is hopeless.
 */
export async function recordFailedLogin(
  client: pg.PoolClient | pg.Pool,
  operatorId: string,
): Promise<void> {
  await client.query(
    `UPDATE operators
        SET failed_logins = failed_logins + 1,
            locked_until = CASE WHEN failed_logins + 1 >= 5
                                THEN now() + interval '15 minutes'
                                ELSE locked_until END
      WHERE id = $1`,
    [operatorId],
  );
}

export async function recordSuccessfulLogin(
  client: pg.PoolClient | pg.Pool,
  operatorId: string,
): Promise<void> {
  await client.query(
    `UPDATE operators
        SET failed_logins = 0, locked_until = NULL, last_login_at = now()
      WHERE id = $1`,
    [operatorId],
  );
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly operatorId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly operatorStatus: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export async function insertSession(
  client: pg.PoolClient | pg.Pool,
  params: {
    id: string; operatorId: string; tokenHash: string;
    expiresAt: Date; ip: string | null; userAgent: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO operator_sessions
       (id, operator_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      params.id, params.operatorId, params.tokenHash, params.expiresAt,
      params.ip?.slice(0, 64) ?? null, params.userAgent?.slice(0, 400) ?? null,
    ],
  );
}

/**
 * Look up a live session by the HASH of its token.
 *
 * Joins the operator, so a suspended account's sessions stop working at once
 * without anyone having to revoke each one. That is the same reasoning as
 * joining `agents.status` in the credential lookup (Phase 5): disabling the
 * principal must disable every credential it holds.
 */
export async function findSessionByTokenHash(
  client: pg.PoolClient | pg.Pool,
  tokenHash: string,
): Promise<SessionRecord | null> {
  const result = await client.query<{
    id: string; operator_id: string; email: string; display_name: string;
    role: string; status: string; expires_at: Date; revoked_at: Date | null;
  }>(
    `SELECT s.id, s.operator_id, s.expires_at, s.revoked_at,
            o.email, o.display_name, o.role, o.status
       FROM operator_sessions s
       JOIN operators o ON o.id = s.operator_id
      WHERE s.token_hash = $1`,
    [tokenHash],
  );

  const row = result.rows[0];
  if (row === undefined) return null;

  return {
    sessionId: row.id, operatorId: row.operator_id,
    email: row.email, displayName: row.display_name,
    role: row.role as Role, operatorStatus: row.status,
    expiresAt: row.expires_at, revokedAt: row.revoked_at,
  };
}

export async function touchSession(
  client: pg.PoolClient | pg.Pool,
  sessionId: string,
): Promise<void> {
  await client.query(
    `UPDATE operator_sessions SET last_seen_at = now() WHERE id = $1`, [sessionId],
  );
}

export async function revokeSession(
  client: pg.PoolClient | pg.Pool,
  sessionId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE operator_sessions
        SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, reason.slice(0, 200)],
  );
}

/** Kill every session an operator holds. The "compromised account" button. */
export async function revokeAllSessions(
  client: pg.PoolClient | pg.Pool,
  operatorId: string,
  reason: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE operator_sessions
        SET revoked_at = now(), revoked_reason = $2
      WHERE operator_id = $1 AND revoked_at IS NULL`,
    [operatorId, reason.slice(0, 200)],
  );

  return result.rowCount ?? 0;
}
