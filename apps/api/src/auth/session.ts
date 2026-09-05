/**
 * Session tokens.
 *
 * A session token is a BEARER CREDENTIAL: whoever holds it IS the user. Two
 * consequences drive everything here.
 *
 * 1. IT MUST BE UNGUESSABLE. 32 bytes from a CSPRNG, base64url. Not a UUID:
 *    UUIDv4 carries 122 bits and, more importantly, "it looks random" is not a
 *    property anyone should have to reason about for a credential.
 *
 * 2. WE MUST NOT STORE IT. The database keeps a SHA-256 of the token, so a
 *    database dump hands an attacker no live sessions. Unlike a password, a
 *    plain SHA-256 is right here: the token already has full entropy, so there
 *    is nothing to brute-force and no reason to pay for a slow hash on every
 *    single request.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'atl_session';

/**
 * Eight hours - about a working day.
 *
 * Long enough that a compliance officer is not re-authenticating all afternoon;
 * short enough that a laptop left open overnight is not an open console in the
 * morning.
 */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface MintedSession {
  /** Given to the client, once. We never see it again in this form. */
  readonly token: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export function mintSessionToken(now: Date, ttlMs = SESSION_TTL_MS): MintedSession {
  const token = randomBytes(32).toString('base64url');

  return {
    token,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(now.getTime() + ttlMs),
  };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of two token hashes. */
export function sessionHashesMatch(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    if (left.length !== right.length || left.length === 0) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/**
 * Cookie attributes, and every one of them is doing a job.
 *
 *   HttpOnly  JavaScript cannot read it, so an XSS bug cannot steal the
 *             session. This is the single most valuable attribute here.
 *   SameSite=Lax  the cookie is not sent on cross-site POSTs, which is CSRF
 *             protection for every mutating endpoint at once. Lax rather than
 *             Strict so following a link into the console still works.
 *   Secure    HTTPS only. Omitted on localhost, because a Secure cookie over
 *             plain http is simply never sent and the failure is baffling.
 *   Path=/    the whole console.
 *   Max-Age   matches the server-side expiry. The server's copy is
 *             authoritative; this only stops the browser sending a stale one.
 */
export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));

  return [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/**
 * Read our cookie out of a Cookie header, without a cookie-parser dependency.
 *
 * Deliberately strict: it looks for exactly our name and ignores everything
 * else. Lenient cookie parsing is a source of real bugs, because a header can
 * legitimately contain many cookies and an attacker may control some of them.
 */
export function readSessionCookie(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    if (part.slice(0, separator).trim() === SESSION_COOKIE) {
      const value = part.slice(separator + 1).trim();
      // base64url alphabet only, bounded. Anything else is not ours.
      return /^[A-Za-z0-9_-]{16,512}$/.test(value) ? value : null;
    }
  }

  return null;
}

/* ------------------------------------------------------------------------ */
/* Roles                                                                    */
/* ------------------------------------------------------------------------ */

export const ROLES = ['viewer', 'compliance', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Ranked, so `requireRole('compliance')` admits an admin.
 *
 * An explicit rank rather than string comparison: alphabetically 'admin' sorts
 * before 'compliance' before 'viewer', which is the exact opposite of the
 * intended ordering. That is a bug waiting for somebody to write `>=`.
 */
const RANK: Record<Role, number> = { viewer: 1, compliance: 2, admin: 3 };

export function roleAtLeast(actual: string, required: Role): boolean {
  const rank = RANK[actual as Role];
  return rank !== undefined && rank >= RANK[required];
}
