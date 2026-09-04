/**
 * Typed, validated application configuration.
 *
 * The ONLY place in this codebase allowed to read process.env.
 * Everything else receives a `Config` object. That gives us:
 *   - one obvious list of every input the service needs
 *   - a startup failure (loud, immediate, readable) instead of a runtime
 *     failure (quiet, delayed, mysterious) when config is wrong
 *   - testability: tests pass a fake env instead of mutating the real one
 */
import { z } from 'zod';

/** Thrown when the environment is unusable. Named so callers can catch it. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Treat an empty/whitespace string as "not provided".
 *
 * Why this exists: `.env` lines like `ANTHROPIC_API_KEY=` produce the string
 * '', not undefined. Without this, `.optional()` accepts '' and the failure
 * surfaces much later as a confusing 401 from the upstream API instead of
 * "you forgot to set the key".
 */
const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    /** z.coerce because every env var is a string; "8080" must become 8080. */
    PORT: z.coerce
      .number({ error: 'must be a number, e.g. 8080' })
      .int('must be a whole number')
      .min(1, 'must be >= 1')
      .max(65535, 'must be <= 65535 (TCP ports are 16-bit)')
      .default(8080),

    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
      .default('info'),

    DATABASE_URL: z
      .string({ error: 'is required (see .env.example)' })
      .min(1, 'is required (see .env.example)')
      .refine(
        (url) => url.startsWith('postgres://') || url.startsWith('postgresql://'),
        { message: 'must be a PostgreSQL URL starting with postgres:// or postgresql://' },
      ),

    /* --- Optional until the phase that needs them --------------------- */

    /** Phase 8: agent runtime. */
    ANTHROPIC_API_KEY: optionalText,

    /** Phase 7: real Razorpay test-mode payments. TEST KEYS ONLY. */
    RAZORPAY_KEY_ID: optionalText,
    RAZORPAY_KEY_SECRET: optionalText,
    RAZORPAY_WEBHOOK_SECRET: optionalText,

    /**
     * Phase 5: signs the single-use voucher that the policy engine mints on
     * PASS and that the payment service demands before capturing money.
     * 32 bytes of hex = 64 characters. Shorter keys weaken the HMAC.
     */
    VOUCHER_SIGNING_SECRET: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().min(64, 'must be at least 64 hex characters (32 random bytes)').optional(),
    ),
  })
  /**
   * Cross-field rule: things we tolerate missing in development must be
   * present in production. Catches the classic "deployed without the signing
   * secret and silently disabled a security control" incident.
   */
  .refine(
    (cfg) => cfg.NODE_ENV !== 'production' || cfg.VOUCHER_SIGNING_SECRET !== undefined,
    {
      path: ['VOUCHER_SIGNING_SECRET'],
      message: 'is required when NODE_ENV=production',
    },
  );

export type Config = Readonly<z.infer<typeof configSchema>>;

/**
 * Validate an environment and return typed config, or throw ConfigError.
 *
 * @param env defaults to process.env; tests inject a fake object instead of
 *            mutating global state.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);

  if (!result.success) {
    // Report EVERY problem at once, so one restart fixes all of them.
    //
    // SECURITY: we print the variable name and the rule it broke, never the
    // value received. Printing values would leak secrets into terminals, CI
    // logs and screenshots. There is a test asserting this.
    const problems = result.error.issues
      .map((issue) => {
        const field = issue.path.length > 0 ? issue.path.join('.') : '(config)';
        return `  - ${field}: ${issue.message}`;
      })
      .join('\n');

    throw new ConfigError(
      `Invalid environment configuration:\n${problems}\n\n` +
        `Fix: copy .env.example to .env and fill in the values.`,
    );
  }

  // Object.freeze: config is read-once, read-only. A later bug that tries to
  // reassign config.PORT fails loudly instead of changing behaviour at runtime.
  return Object.freeze(result.data);
}

/**
 * A version of the config that is safe to log.
 * Secrets are reduced to a boolean "is it set" - which is the only thing you
 * ever actually need at startup, and is not itself sensitive.
 */
export function describeConfig(config: Config): Record<string, string | number | boolean> {
  return {
    NODE_ENV: config.NODE_ENV,
    PORT: config.PORT,
    LOG_LEVEL: config.LOG_LEVEL,
    // Host only. The full URL can embed a password.
    database: new URL(config.DATABASE_URL).host,
    anthropicKeySet: config.ANTHROPIC_API_KEY !== undefined,
    razorpayKeysSet: config.RAZORPAY_KEY_ID !== undefined && config.RAZORPAY_KEY_SECRET !== undefined,
    voucherSecretSet: config.VOUCHER_SIGNING_SECRET !== undefined,
  };
}
