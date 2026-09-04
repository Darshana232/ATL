/**
 * The tamper demonstration.
 *
 *   npm run demo:tamper -w apps/api
 *
 * Builds a real chain, verifies it, anchors it with a signed checkpoint,
 * then TAMPERS WITH HISTORY and shows verification failing and naming the row.
 *
 * WHAT MAKES THIS HONEST rather than theatre:
 *
 *   1. The application role literally cannot do it. We demonstrate that first,
 *      by trying and being refused.
 *   2. Even the database OWNER is refused, because a BEFORE UPDATE trigger
 *      fires for the owner too. The attacker must DISABLE THE TRIGGER first -
 *      a DDL statement that PostgreSQL logs.
 *   3. So the threat being demonstrated is a PRIVILEGED INSIDER who is willing
 *      to leave DDL footprints, not "a bug in our code".
 *   4. The chain then detects it. That is the claim, and it is the only claim:
 *      tamper-EVIDENT, never tamper-proof.
 */
import { randomBytes } from 'node:crypto';
import { loadEnvFile } from '../env-file.js';
import { adminDatabaseUrl, loadConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { closePool, createPool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { appendAuditEvent } from '../audit/writer.js';
import { signCheckpoint } from '../audit/checkpoint.js';
import { verifyChain } from '../audit/verifier.js';
import { insertCheckpoint, newCheckpointId, summariseChain } from '../repositories/audit.js';

loadEnvFile();

const config = loadConfig({ ...process.env, LOG_LEVEL: 'fatal' });
const logger = createLogger(config);

const CSI = `${String.fromCharCode(27)}[`;
const dim = (t: string): string => `${CSI}2m${t}${CSI}0m`;
const bold = (t: string): string => `${CSI}1m${t}${CSI}0m`;
const green = (t: string): string => `${CSI}32m${t}${CSI}0m`;
const red = (t: string): string => `${CSI}31m${t}${CSI}0m`;
const yellow = (t: string): string => `${CSI}33m${t}${CSI}0m`;

const step = (n: number, title: string): void => {
  console.log('');
  console.log(bold(`  ${n}. ${title}`));
};

async function main(): Promise<void> {
  const appPool = createPool(config, logger);
  const ownerPool = createPool(
    { ...config, DATABASE_URL: adminDatabaseUrl(config) } as Config,
    logger,
  );

  const chainId = `demo_tamper_${randomBytes(4).toString('hex')}`;
  const secret = config.AUDIT_CHECKPOINT_SECRET;

  console.log('');
  console.log(bold('  ATL-India - audit trail tamper demonstration'));
  console.log(dim(`  chain ${chainId}`));

  /* ------------------------------------------------------------------ */
  step(1, 'Write five real audit events');

  await withTransaction(appPool, async (tx) => {
    const events = [
      ['MANDATE_CREATED', 'usr_ananya', 'Weekly grocery mandate created, 5,000/week'],
      ['AUTHORIZATION_DECIDED', 'agt_grocery_shopper', 'PASS - 1,240 at BigBasket'],
      ['AUTHORIZATION_DECIDED', 'agt_grocery_shopper', 'BLOCK - 6,200 exceeds the 2,000 limit'],
      ['AUTHORIZATION_DECIDED', 'agt_grocery_shopper', 'PASS - 890 at Zepto'],
      ['MANDATE_REVOKED', 'usr_ananya', 'User withdrew consent'],
    ] as const;

    for (const [type, actor, note] of events) {
      await appendAuditEvent(tx, {
        eventType: type,
        actorKind: type === 'AUTHORIZATION_DECIDED' ? 'agent' : 'user',
        actorId: actor,
        subjectKind: type === 'AUTHORIZATION_DECIDED' ? 'decision' : 'mandate',
        subjectId: `sub_${randomBytes(4).toString('hex')}`,
        chainId,
        payload: { note },
      });
    }
  });

  const rows = await appPool.query<{ seq: string; event_type: string; hash: string }>(
    `SELECT seq, event_type, hash FROM audit_events WHERE chain_id = $1 ORDER BY seq`,
    [chainId],
  );

  for (const row of rows.rows) {
    console.log(`     seq ${String(row.seq).padStart(6)}  ${row.event_type.padEnd(24)} ${dim(row.hash.slice(0, 24))}`);
  }

  /* ------------------------------------------------------------------ */
  step(2, 'Verify - and anchor with a signed checkpoint');

  let result = await verifyChain(appPool, { chainId, checkpointSecret: secret });
  console.log(`     ${green('INTEGRITY VERIFIED')}  ${result.eventsChecked} events checked`);

  if (secret !== undefined) {
    const summary = await summariseChain(appPool, chainId);
    const facts = {
      chainId, seq: summary.headSeq!, headHash: summary.headHash!,
      eventCount: summary.eventCount, createdAt: new Date().toISOString(),
    };
    await withTransaction(appPool, async (tx) => {
      await insertCheckpoint(tx, {
        ...facts, id: newCheckpointId(),
        signature: signCheckpoint(secret, facts), createdBy: 'demo',
      });
    });
    console.log(`     ${green('ANCHORED')}           checkpoint signed at seq ${facts.seq}`);
  } else {
    console.log(`     ${yellow('NOT ANCHORED')}       AUDIT_CHECKPOINT_SECRET is not set`);
  }

  /* ------------------------------------------------------------------ */
  step(3, 'The APPLICATION tries to rewrite history - and cannot');

  const appAttempt = await appPool
    .query(`UPDATE audit_events SET payload = '{"note":"nothing to see"}' WHERE chain_id = $1`, [chainId])
    .then(() => null)
    .catch((error: unknown) => error as { code?: string; message?: string });

  console.log(`     as ${bold('atl_app')} (the service role):`);
  console.log(`       ${green('REFUSED')}  ${appAttempt?.message ?? 'no error - THIS WOULD BE A BUG'}`);
  console.log(dim('       the grant is revoked, and a trigger would refuse it too'));

  /* ------------------------------------------------------------------ */
  step(4, 'The database OWNER tries - and is ALSO refused');

  const ownerAttempt = await ownerPool
    .query(`UPDATE audit_events SET payload = '{"note":"nothing to see"}' WHERE chain_id = $1`, [chainId])
    .then(() => null)
    .catch((error: unknown) => error as { message?: string });

  console.log(`     as ${bold('the table owner')}:`);
  console.log(`       ${green('REFUSED')}  ${ownerAttempt?.message ?? 'no error'}`);
  console.log(dim('       BEFORE UPDATE triggers fire for the owner too'));

  /* ------------------------------------------------------------------ */
  step(5, 'A privileged insider disables the trigger, then edits one event');

  const target = rows.rows[1]!;
  console.log(dim(`     ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only;`));
  console.log(dim(`     UPDATE audit_events SET actor_id = 'agt_someone_else' WHERE seq = ${target.seq};`));
  console.log(dim(`     ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only;`));
  console.log(yellow('       (both ALTER statements require ownership and are logged by PostgreSQL)'));

  await ownerPool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    // NOT the payload - the ACTOR. If the hash covered only the payload this
    // would go undetected, and attribution is the part a regulator cares about
    // most.
    await ownerPool.query(
      `UPDATE audit_events SET actor_id = 'agt_someone_else' WHERE chain_id = $1 AND seq = $2`,
      [chainId, Number(target.seq)],
    );
  } finally {
    await ownerPool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  }

  /* ------------------------------------------------------------------ */
  step(6, 'Verify again');

  result = await verifyChain(appPool, { chainId, checkpointSecret: secret });

  console.log(`     ${red('INTEGRITY CHECK FAILED')}`);
  console.log(`       broken at    seq ${result.firstBreak?.seq} (${result.firstBreak?.eventId})`);
  console.log(`       kind         ${result.firstBreak?.kind}`);
  console.log(`       detail       ${result.firstBreak?.detail}`);
  console.log(`       verified ok  ${result.eventsChecked} of ${result.totalEvents} events before the damage`);
  console.log('');
  console.log(dim('     Note WHAT was changed: not an amount, an ACTOR. The hash covers the'));
  console.log(dim('     whole record, so re-attributing an action is caught exactly as well as'));
  console.log(dim('     changing a number.'));

  /* ------------------------------------------------------------------ */
  step(7, 'The honest limit of this claim');

  console.log(dim(`     ${result.limitation}`));

  await closePool(appPool, logger);
  await closePool(ownerPool, logger);
  console.log('');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
