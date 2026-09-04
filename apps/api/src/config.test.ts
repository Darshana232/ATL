import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig } from './config.js';

/**
 * The minimum viable environment. Tests start from this and break one thing at
 * a time, so a failure tells you exactly which rule caught it.
 */
const baseEnv = {
  DATABASE_URL: 'postgres://user@localhost:5432/atl_india_dev',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig - happy path', () => {
  it('applies defaults when only DATABASE_URL is provided', () => {
    const config = loadConfig({ ...baseEnv });

    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(8080);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('coerces PORT from string to number', () => {
    // Every environment variable is a string. Config must hand the rest of the
    // app a real number, or `PORT + 1` silently becomes "80801".
    const config = loadConfig({ ...baseEnv, PORT: '3000' });

    expect(config.PORT).toBe(3000);
    expect(typeof config.PORT).toBe('number');
  });

  it('returns a frozen object so config cannot be mutated at runtime', () => {
    const config = loadConfig({ ...baseEnv });

    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      (config as { PORT: number }).PORT = 1;
    }).toThrow();
  });
});

describe('loadConfig - rejects bad input', () => {
  it('fails when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('fails when DATABASE_URL is not a PostgreSQL URL', () => {
    // Prevents a confusing protocol error deep inside the driver.
    expect(() => loadConfig({ DATABASE_URL: 'mysql://user@localhost:3306/db' })).toThrow(
      /PostgreSQL URL/,
    );
  });

  it('fails when PORT is not numeric', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('fails when PORT is outside the valid TCP range', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...baseEnv, PORT: '0' })).toThrow(/PORT/);
  });

  it('fails on an unknown LOG_LEVEL', () => {
    expect(() => loadConfig({ ...baseEnv, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('reports every problem at once, not just the first', () => {
    // One restart should be enough to fix a batch of typos.
    let message = '';
    try {
      loadConfig({ PORT: 'abc', LOG_LEVEL: 'nope' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/PORT/);
    expect(message).toMatch(/LOG_LEVEL/);
  });
});

describe('loadConfig - empty string is treated as missing', () => {
  it('turns an empty ANTHROPIC_API_KEY into undefined', () => {
    // `.env` lines like `ANTHROPIC_API_KEY=` yield '', not undefined.
    // Without the preprocess step this would pass validation and fail much
    // later as an opaque 401 from the upstream API.
    const config = loadConfig({ ...baseEnv, ANTHROPIC_API_KEY: '' });

    expect(config.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('treats whitespace-only values as missing', () => {
    const config = loadConfig({ ...baseEnv, RAZORPAY_KEY_ID: '   ' });

    expect(config.RAZORPAY_KEY_ID).toBeUndefined();
  });

  it('keeps a real value intact', () => {
    const config = loadConfig({ ...baseEnv, ANTHROPIC_API_KEY: 'sk-ant-example' });

    expect(config.ANTHROPIC_API_KEY).toBe('sk-ant-example');
  });
});

describe('loadConfig - production hardening', () => {
  const productionEnv = {
    ...baseEnv,
    NODE_ENV: 'production',
  } satisfies NodeJS.ProcessEnv;

  it('refuses to boot in production without VOUCHER_SIGNING_SECRET', () => {
    // The voucher secret is what stops the agent from capturing money without
    // a policy-engine decision. Deploying without it disables a security
    // control silently - so we make that impossible instead.
    expect(() => loadConfig(productionEnv)).toThrow(/VOUCHER_SIGNING_SECRET/);
  });

  it('boots in production when the secret is present', () => {
    const config = loadConfig({
      ...productionEnv,
      VOUCHER_SIGNING_SECRET: 'a'.repeat(64),
    });

    expect(config.NODE_ENV).toBe('production');
    expect(config.VOUCHER_SIGNING_SECRET).toHaveLength(64);
  });

  it('rejects a signing secret that is too short to be a strong HMAC key', () => {
    expect(() =>
      loadConfig({ ...baseEnv, VOUCHER_SIGNING_SECRET: 'tooshort' }),
    ).toThrow(/VOUCHER_SIGNING_SECRET/);
  });
});

describe('security - configuration errors must not leak secret values', () => {
  it('never includes the received value in the error message', () => {
    // If this test fails, we are writing secrets into terminals, CI logs and
    // any screenshot of them. The message may name the variable and the rule
    // it broke - never the value.
    const leakyValue = 'super-secret-value-that-must-not-be-printed';
    let message = '';

    try {
      loadConfig({ ...baseEnv, VOUCHER_SIGNING_SECRET: leakyValue });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/VOUCHER_SIGNING_SECRET/);
    expect(message).not.toContain(leakyValue);
  });
});

describe('describeConfig - safe to log', () => {
  it('reduces secrets to booleans and never emits their values', () => {
    const config = loadConfig({
      ...baseEnv,
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      VOUCHER_SIGNING_SECRET: 'b'.repeat(64),
    });

    const described = describeConfig(config);
    const serialised = JSON.stringify(described);

    expect(described.anthropicKeySet).toBe(true);
    expect(described.voucherSecretSet).toBe(true);
    expect(serialised).not.toContain('sk-ant-secret');
    expect(serialised).not.toContain('b'.repeat(64));
  });

  it('logs only the database host, never credentials embedded in the URL', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://admin:hunter2@db.internal:5432/atl',
    });

    const serialised = JSON.stringify(describeConfig(config));

    expect(serialised).toContain('db.internal:5432');
    expect(serialised).not.toContain('hunter2');
  });
});
