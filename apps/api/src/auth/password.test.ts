/**
 * Password hashing.
 *
 * The claim is "we cannot recover a password, and an attacker holding this
 * table cannot cheaply guess one". Each test names what it prevents.
 */
import { describe, expect, it } from 'vitest';
import { burnPasswordTime, hashPassword, verifyPassword } from './password.js';

describe('hashing', () => {
  it('never contains the password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash).not.toContain('correct-horse');
  });

  it('produces a DIFFERENT hash for the same password every time', async () => {
    // A per-password salt. Without it, identical passwords produce identical
    // hashes, so one rainbow table cracks every account at once and an attacker
    // can see which users share a password.
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');

    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('records its own cost parameters', async () => {
    // A hash that cannot record its cost is a hash you can never strengthen:
    // raising N would invalidate every existing password.
    expect(await hashPassword('x')).toMatch(/^scrypt\$\d+\$\d+\$\d+\$/);
  });

  it('matches the database CHECK constraint shape', async () => {
    const hash = await hashPassword('x');
    expect(hash).toMatch(/^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });
});

describe('verification', () => {
  it('accepts the right password', async () => {
    const hash = await hashPassword('hunter2-but-longer');
    expect(await verifyPassword('hunter2-but-longer', hash)).toBe(true);
  });

  it('rejects a wrong password, including a one-character difference', async () => {
    const hash = await hashPassword('hunter2-but-longer');

    expect(await verifyPassword('hunter2-but-longeR', hash)).toBe(false);
    expect(await verifyPassword('hunter2-but-longe', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('verifies against OLDER parameters, so cost can be raised later', async () => {
    // Hand-built with N=16384 (half the current cost). Reading the parameters
    // back from the stored hash is what makes an upgrade possible without
    // logging everybody out.
    const { scrypt } = await import('node:crypto');
    const { promisify } = await import('node:util');
    const derive = promisify(scrypt) as (
      p: string, s: Buffer, l: number, o: Record<string, number>,
    ) => Promise<Buffer>;

    const salt = Buffer.from('0123456789abcdef');
    const key = await derive('legacy-password', salt, 32,
                             { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const stored = `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;

    expect(await verifyPassword('legacy-password', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    // A security check whose outcome depends on the caller's catch block is not
    // a check.
    for (const bad of ['', 'not-a-hash', 'scrypt$x$y$z$a$b', 'bcrypt$1$2$3$a$b',
                       'scrypt$32768$8$1$onlyfivefields']) {
      expect(await verifyPassword('anything', bad), bad).toBe(false);
    }
  });
});

describe('user enumeration', () => {
  it('burning time costs about as much as a real verification', async () => {
    // WHAT THIS PREVENTS: if "no such user" returned instantly and "wrong
    // password" took 200 ms, the response time alone would tell an attacker
    // which addresses are registered - an enumeration oracle built out of a
    // stopwatch.
    const hash = await hashPassword('a-real-password');

    const realStart = process.hrtime.bigint();
    await verifyPassword('a-guess', hash);
    const realMs = Number(process.hrtime.bigint() - realStart) / 1e6;

    const burnStart = process.hrtime.bigint();
    await burnPasswordTime('a-guess');
    const burnMs = Number(process.hrtime.bigint() - burnStart) / 1e6;

    // Same order of magnitude. Not an exact comparison - timing on a machine
    // also running a test suite is noisy, and asserting a tight bound would
    // make this test flaky rather than meaningful.
    expect(burnMs).toBeGreaterThan(realMs / 10);
    expect(await burnPasswordTime('anything')).toBe(false);
  });
});
