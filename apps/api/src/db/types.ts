/**
 * PostgreSQL type parser registration.
 *
 * node-postgres decides how to turn wire-format strings into JS values. Its
 * default for int8 (BIGINT) is to LEAVE IT AS A STRING, deliberately, because
 * BIGINT can hold values a JS number cannot represent exactly.
 *
 * That default is correct but surprising, and the naive fix - Number(value) -
 * silently corrupts anything above 2^53. We install a parser that returns a
 * number when it is exact and THROWS when it would not be.
 */
import pg from 'pg';
import { parsePostgresInt8 } from '../money.js';

/**
 * OID 20 is int8/BIGINT in PostgreSQL's system catalogue. These numbers are
 * stable across versions; you can confirm with:
 *   SELECT oid, typname FROM pg_type WHERE typname = 'int8';
 */
const PG_INT8_OID = 20;

let registered = false;

/**
 * Register our parsers. Idempotent.
 *
 * CAVEAT worth understanding: pg.types.setTypeParser mutates PROCESS-GLOBAL
 * state - it affects every pool and every client in this process, not just
 * ours. Global mutable state is normally a smell, but it is the API the
 * library gives us, so we contain it in one function, make it idempotent, and
 * call it from exactly one place (createPool) rather than scattering it.
 *
 * The upside of it being global: BIGINT is also what COUNT(*) returns, so
 * counts now come back as real numbers instead of strings everywhere.
 */
export function registerPostgresTypeParsers(): void {
  if (registered) return;

  pg.types.setTypeParser(PG_INT8_OID, parsePostgresInt8);

  registered = true;
}
