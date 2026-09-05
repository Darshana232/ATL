/**
 * Password hashing.
 *
 * WE MUST NEVER BE ABLE TO RECOVER A PASSWORD. So this is a one-way hash, not
 * encryption, and it is a DELIBERATELY SLOW one: scrypt is memory-hard, meaning
 * an attacker cannot trade memory for parallelism cheaply the way they can with
 * a plain iterated hash. A GPU farm buys far less against scrypt than against
 * SHA-256.
 *
 * COMPARE THE THREE CREDENTIAL DECISIONS IN THIS SYSTEM, because they look
 * inconsistent until you ask what the VERIFIER needs:
 *
 *   password        client sends the secret, we compare  -> store a SLOW HASH
 *   voucher (HMAC)  we recompute the MAC                 -> store the KEY
 *   agent signature we verify a signature                -> store the PUBLIC half
 *
 * One rule, three answers. ADR-0015 argued the second and third; this is the
 * first.
 *
 * PRODUCTION NOTE: argon2id is the current preferred choice and won the
 * Password Hashing Competition. Node does not ship it, and pulling in a native
 * dependency for an MVP buys little over scrypt, which is standardised
 * (RFC 7914) and in the standard library. The parameters are stored WITH each
 * hash so cost can be raised later without invalidating existing passwords.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string, salt: Buffer, keylen: number, options: Record<string, number>,
) => Promise<Buffer>;

/**
 * Cost parameters.
 *
 * N=2^15 with r=8, p=1 needs about 32 MB and a few hundred milliseconds. That
 * is the point: a login taking 200 ms is invisible to a human and ruinous to
 * someone trying billions of guesses.
 *
 * `maxmem` must be raised explicitly - Node's default is 32 MB and N=2^15
 * needs slightly more, so leaving it produces a confusing runtime error rather
 * than a slow hash.
 */
const PARAMS = { N: 32_768, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** `scrypt$N$r$p$salt$hash`, matching `operators_password_hash_shape`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    ...PARAMS, maxmem: 64 * 1024 * 1024,
  });

  return [
    'scrypt', PARAMS.N, PARAMS.r, PARAMS.p,
    salt.toString('base64'), derived.toString('base64'),
  ].join('$');
}

/**
 * Verify a password. Returns a boolean; never throws.
 *
 * The stored parameters are read back from the hash rather than assumed, so a
 * password hashed under older, cheaper parameters still verifies after the
 * constants above are raised.
 *
 * Comparison is constant-time. `===` on the derived keys would leak, through
 * timing, how many leading bytes an attacker had guessed correctly.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');

    const derived = await scrypt(password, salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024,
    });

    if (derived.length !== expected.length) return false;

    return timingSafeEqual(derived, expected);
  } catch {
    // Malformed stored hash, absurd parameters, anything at all: this is a
    // failed verification, not an exception that escapes into a 500. A security
    // check whose outcome depends on the caller's catch block is not a check.
    return false;
  }
}

/**
 * Do the work of a verification without having a hash to verify against.
 *
 * WHY THIS EXISTS. If "no such user" returns instantly and "wrong password"
 * takes 200 ms, the response time tells an attacker which email addresses are
 * registered - a user-enumeration oracle built out of nothing but a stopwatch.
 * Hashing against a fixed dummy value makes both paths cost the same.
 */
const DUMMY_HASH_PROMISE = hashPassword('a-password-that-belongs-to-nobody');

export async function burnPasswordTime(password: string): Promise<false> {
  await verifyPassword(password, await DUMMY_HASH_PROMISE);
  return false;
}
