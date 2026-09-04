/**
 * Live end-to-end demonstration of the authorization path.
 *
 * REAL HTTP over a real socket, real Ed25519 signatures made with the seeded
 * agent's private key, a real PostgreSQL database, and the real policy engine.
 * Nothing here is stubbed except the mandate RAIL itself, which is labelled as
 * simulated in every response.
 *
 *   npm run demo:authorize -w apps/api
 *
 * Requires `npm run seed` to have run at least once, because it signs with the
 * private key that seeding wrote to the gitignored .seed-keys.json.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../env-file.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createPool, closePool } from '../db/pool.js';
import { buildServer } from '../server.js';
import { formatPaise } from '../money.js';
import {
  hashBody, signRequest, KEY_HEADER, TIMESTAMP_HEADER,
  IDEMPOTENCY_HEADER, SIGNATURE_HEADER,
} from '../auth/signing.js';
import { verifyVoucher } from '../voucher/voucher.js';

loadEnvFile();

const KEYS_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../../../.seed-keys.json',
);

interface SeedKey {
  agentId: string;
  keyId: string;
  privateKeyPkcs8B64: string;
}

const config = loadConfig({ ...process.env, LOG_LEVEL: 'fatal' });

/**
 * The demo clock is PINNED, and it is labelled as pinned on screen.
 *
 * The seeded mandate permits 08:00-20:00 Asia/Kolkata, Mon-Sat - a realistic
 * constraint. Run at 04:55 IST, every scenario would block on TIME_WINDOW and
 * the demo would show nothing else. Pinning makes the run reproducible at any
 * hour of the day.
 *
 * It is the SAME `now` on both sides: the server's clock and the timestamp the
 * client signs. That is not a special case for the demo - it is the ordinary
 * dependency-injected clock the engine and the freshness check already use.
 * Every other part of this run is live: real socket, real signatures, real
 * database, real rules.
 */
const DEMO_NOW = new Date('2026-09-07T08:52:00Z'); // Monday, 14:22 IST
const logger = createLogger(config);

const CSI = `${String.fromCharCode(27)}[`;
const dim = (text: string): string => `${CSI}2m${text}${CSI}0m`;
const bold = (text: string): string => `${CSI}1m${text}${CSI}0m`;
const colour = (verdict: string): string => {
  const code = verdict === 'PASS' ? 32 : verdict === 'FLAG' ? 33 : 31;
  return `${CSI}${code}m${verdict}${CSI}0m`;
};

interface Scenario {
  readonly title: string;
  readonly body: Record<string, unknown>;
  readonly expect: string;
}

async function send(
  base: string,
  key: SeedKey,
  body: Record<string, unknown>,
  options: { idempotencyKey?: string; tamperedBody?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  const idempotencyKey =
    options.idempotencyKey ?? `demo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = DEMO_NOW.toISOString();

  const signature = signRequest(key.privateKeyPkcs8B64, {
    method: 'POST', path: '/v1/authorize', timestamp,
    keyId: key.keyId, idempotencyKey, bodySha256: hashBody(payload),
  });

  const response = await fetch(`${base}/v1/authorize`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [KEY_HEADER]: key.keyId,
      [TIMESTAMP_HEADER]: timestamp,
      [IDEMPOTENCY_HEADER]: idempotencyKey,
      [SIGNATURE_HEADER]: signature,
    },
    // The bytes SENT may differ from the bytes SIGNED - that is the tamper demo.
    body: options.tamperedBody ?? payload,
  });

  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function run(base: string, key: SeedKey, scenario: Scenario): Promise<void> {
  const { status, json } = await send(base, key, scenario.body);

  console.log(`  ${bold(scenario.title)}  ${dim(`(expect ${scenario.expect})`)}`);
  console.log(dim(`  HTTP ${status}`));

  const evaluations = (json.evaluations ?? []) as {
    ruleCode: string; sequence: number; verdict: string; reason: string;
  }[];

  for (const item of evaluations) {
    const mark = item.verdict === 'BLOCK' ? 'x ' : item.verdict === 'SKIP' ? '- ' : 'ok';
    console.log(
      `    ${String(item.sequence).padStart(2)} ${mark} ` +
      `${item.ruleCode.padEnd(24)} ${colour(item.verdict)}`,
    );
  }

  console.log(`    verdict : ${colour(String(json.verdict))}`);
  console.log(`    reason  : ${String(json.reason)}`);
  console.log(
    `    voucher : ${json.voucher === null ? bold('none - nothing can be spent') : 'issued'}`,
  );

  if (json.voucher !== null && json.voucher !== undefined) {
    const voucher = json.voucher as { token: string; jti: string; expiresAt: string };
    const verified = verifyVoucher(config.VOUCHER_SIGNING_SECRET ?? '', voucher.token, DEMO_NOW);

    console.log(dim(`              jti ${voucher.jti}  expires ${voucher.expiresAt}`));
    console.log(
      dim(`              independently verified: ${verified.ok ? 'YES' : `NO (${verified.why})`}`),
    );
    if (verified.ok) {
      console.log(
        dim(`              permits exactly ${formatPaise(verified.claims.amountPaise)} at ` +
            `${verified.claims.merchantId}, once`),
      );
    }
  }
  console.log('');
}

async function replayDemo(base: string, key: SeedKey): Promise<void> {
  console.log(bold('  Replay / retry: the same signed request, sent twice'));

  const body = {
    mandateId: 'mnd_weekly_groceries', merchantId: 'mer_bigbasket',
    amountPaise: 99_900, paymentMethod: 'upi_reserve_pay',
  };
  const idempotencyKey = `demo_replay_${Date.now()}`;

  const first = await send(base, key, body, { idempotencyKey });
  const second = await send(base, key, body, { idempotencyKey });

  console.log(`    first  -> decision ${String(first.json.decisionId)}`);
  console.log(`    second -> decision ${String(second.json.decisionId)}`);
  console.log(
    `    same decision: ${bold(String(first.json.decisionId === second.json.decisionId))}` +
    dim('   (UNIQUE (agent_id, idempotency_key) - no nonce table needed)'),
  );
  console.log(
    `    second response flagged as a replay: ${bold(String(second.json.idempotentReplay))}`,
  );
  console.log('');
}

async function tamperDemo(base: string, key: SeedKey): Promise<void> {
  console.log(bold('  Tampering: sign 1,240 rupees, send 99,999 rupees'));

  const signed = {
    mandateId: 'mnd_weekly_groceries', merchantId: 'mer_bigbasket',
    amountPaise: 124_000, paymentMethod: 'upi_reserve_pay',
  };
  const sent = JSON.stringify({ ...signed, amountPaise: 9_999_900 });

  const { status, json } = await send(base, key, signed, { tamperedBody: sent });

  console.log(`    HTTP ${status}  ${String(json.error ?? '')}`);
  console.log(dim(`    ${String(json.message ?? '')}`));
  console.log(
    `    ${bold('one changed digit invalidates the signature - the body is inside the MAC')}`,
  );
  console.log('');
}

async function main(): Promise<void> {
  const keys = JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as SeedKey[];
  const key = keys.find((k) => k.agentId === 'agt_grocery_shopper');
  if (key === undefined) throw new Error('run `npm run seed` first');

  const pool = createPool(config, logger);
  const app = buildServer({ config, logger, pool, now: () => DEMO_NOW });

  // A real socket on an ephemeral port. inject() would be easier and would
  // prove less: this exercises the HTTP stack the agent runtime will use.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;

  console.log('');
  console.log(bold('  ATL-India - live authorization demo'));
  console.log(dim(`  ${base}   agent agt_grocery_shopper   mandate mnd_weekly_groceries`));
  console.log(dim('  Mandate: 2,000/txn, 5,000/week, BigBasket + Zepto only,'));
  console.log(dim('           08:00-20:00 Asia/Kolkata, Mon-Sat, blocked MCCs 5921 / 7995'));
  console.log(dim(`  Clock pinned to ${DEMO_NOW.toISOString()} (Monday 14:22 IST) so the`));
  console.log(dim('  time-window rule is demonstrable at any hour. Everything else is live.'));
  console.log('');

  const scenarios: Scenario[] = [
    {
      title: 'A compliant grocery order',
      expect: 'PASS + voucher',
      body: {
        mandateId: 'mnd_weekly_groceries', merchantId: 'mer_bigbasket',
        amountPaise: 124_000, paymentMethod: 'upi_reserve_pay',
        userIntent: 'Order this week groceries',
        cart: [{ sku: 'atta-5kg', name: 'Whole wheat atta 5kg', quantity: 1, unitPricePaise: 32_500 }],
      },
    },
    {
      title: 'Over the per-transaction limit',
      expect: 'BLOCK, no voucher',
      body: {
        mandateId: 'mnd_weekly_groceries', merchantId: 'mer_bigbasket',
        amountPaise: 620_000, paymentMethod: 'upi_reserve_pay',
      },
    },
    {
      title: 'A merchant that is not on the allowlist',
      expect: 'BLOCK',
      body: {
        mandateId: 'mnd_weekly_groceries', merchantId: 'mer_zomato',
        amountPaise: 45_000, paymentMethod: 'upi_reserve_pay',
      },
    },
    {
      title: 'A blocked category (MCC 5921, alcohol)',
      expect: 'BLOCK',
      body: {
        mandateId: 'mnd_weekly_groceries', merchantId: 'mer_city_wines',
        amountPaise: 89_000, paymentMethod: 'upi_reserve_pay',
      },
    },
    {
      title: 'Another agent mandate (identity failure)',
      expect: 'BLOCK - MANDATE_AGENT_MATCH',
      body: {
        mandateId: 'mnd_food_evening', merchantId: 'mer_zomato',
        amountPaise: 45_000, paymentMethod: 'upi_reserve_pay',
      },
    },
  ];

  for (const scenario of scenarios) await run(base, key, scenario);

  await replayDemo(base, key);
  await tamperDemo(base, key);

  await app.close();
  await closePool(pool, logger);
  console.log('');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
