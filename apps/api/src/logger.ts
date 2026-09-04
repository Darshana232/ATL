/**
 * Structured logging.
 *
 * Every log line is a JSON object, not a sentence. That is what lets us later
 * ask "show me everything that happened during request 01J..." across the API,
 * the policy engine and the payment adapter - which is impossible with
 * console.log.
 */
import { pino } from 'pino';
import type { Config } from './config.js';

/**
 * Derive the logger type from the library's own return type instead of
 * importing a named type. Works regardless of how pino organises its types,
 * and stays correct if they change.
 */
export type Logger = ReturnType<typeof pino>;

/**
 * Field paths that must never reach a log file.
 *
 * Logs typically live in systems with weaker access controls than the
 * database, so anything sensitive that lands here has effectively escaped our
 * security boundary. Redacting centrally is far more reliable than trusting
 * every future call site to remember.
 *
 * Doubles as a real DPDP data-minimisation control (Phase 10 evidence).
 */
const REDACTED_PATHS = [
  // Credentials in transit
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-atl-signature"]',
  'req.headers["x-atl-key"]',
  'res.headers["set-cookie"]',
  // Secrets anywhere in a logged object (wildcards match one level deep)
  '*.password',
  '*.passwordHash',
  '*.secret',
  '*.apiKey',
  '*.apiSecret',
  '*.token',
  '*.signature',
  '*.voucher',
  // Personal data (DPDP): payment handles and contact details
  '*.upiVpa',
  '*.vpa',
  '*.phone',
  '*.phoneNumber',
  '*.email',
];

export function createLogger(config: Config): Logger {
  const isDevelopment = config.NODE_ENV === 'development';

  return pino({
    level: config.LOG_LEVEL,

    /**
     * Attached to every line, so logs from multiple services and environments
     * remain distinguishable once they are all in one place.
     */
    base: {
      service: 'atl-api',
      env: config.NODE_ENV,
    },

    /** Log `"level":"error"` instead of pino's default `"level":50`. */
    formatters: {
      level: (label) => ({ level: label }),
    },

    /** ISO-8601 timestamps: sortable by machines, readable by humans. */
    timestamp: pino.stdTimeFunctions.isoTime,

    redact: {
      paths: REDACTED_PATHS,
      censor: '[REDACTED]',
    },

    /**
     * In development, pipe through pino-pretty for readable coloured lines.
     * In production we emit raw JSON to stdout and let the hosting platform
     * collect it - the twelve-factor approach. An app should not own log
     * routing; it makes the app responsible for infrastructure concerns and
     * silently loses logs when the destination is unavailable.
     */
    ...(isDevelopment
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname,service,env',
            },
          },
        }
      : {}),
  });
}
