import { apiGet } from '@/lib/api';
import type { AuditEvent, VerificationResult } from '@/lib/types';
import { ApiFailure, Banner, Card, Empty, Hash } from '@/components/ui';
import { formatDateTime } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * The audit trail.
 *
 * WHAT MUST BE VISIBLE IMMEDIATELY: whether the chain verifies. Everything else
 * is detail. So the banner is the first thing, it is full width, and its
 * failure state is unmistakable.
 *
 * WHAT MUST NEVER BE SUPPRESSED: the tamper-EVIDENT caveat. A green
 * "INTEGRITY VERIFIED" banner is exactly the sort of thing that ends up in a
 * pitch deck as "tamper-proof", so the limitation travels with it on screen,
 * not in a footnote.
 */
export default async function AuditPage() {
  let verification: VerificationResult;
  let events: AuditEvent[];

  try {
    verification = await apiGet<VerificationResult>('/v1/audit/verify');
    events = (await apiGet<{ events: AuditEvent[] }>('/v1/audit/events?limit=60')).events;
  } catch (error) {
    return <ApiFailure error={error} />;
  }

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Audit trail</h1>
        <p className="page-sub">
          Every consequential event, hash-chained. Each row commits to its
          predecessor, so altering one event breaks every hash after it.
        </p>
      </header>

      <div className="stack">
        {verification.status === 'intact' ? (
          <Banner kind="ok" title="INTEGRITY VERIFIED">
            {verification.eventsChecked.toLocaleString('en-IN')} of{' '}
            {verification.totalEvents.toLocaleString('en-IN')} events recomputed
            and matched, in {verification.durationMs} ms. Verified{' '}
            {formatDateTime(verification.verifiedAt)}.
          </Banner>
        ) : (
          <Banner kind="error" title="INTEGRITY CHECK FAILED">
            <p style={{ margin: '4px 0' }}>
              <strong>Break at sequence {verification.firstBreak?.seq}</strong>{' '}
              (<span className="mono">{verification.firstBreak?.eventId}</span>) —{' '}
              {verification.firstBreak?.kind}
            </p>
            <p style={{ margin: '4px 0' }}>{verification.firstBreak?.detail}</p>
            <p style={{ margin: '4px 0', fontSize: 12 }}>
              {verification.eventsChecked} events verified before the damage.
              Only the FIRST break is reported: after one broken link every
              later row also fails, and listing them all would describe a single
              edit a million times.
            </p>
          </Banner>
        )}

        <Card
          title="Signed checkpoints"
          hint={`${verification.checkpoints.length} anchors`}
        >
          {verification.checkpoints.length === 0 ? (
            <Empty
              title="No checkpoints yet"
              hint={
                <>
                  Checkpoints detect a <em>consistent full-chain rewrite</em>,
                  which the chain alone cannot. Create one with{' '}
                  <code>POST /v1/audit/checkpoint</code>.
                </>
              }
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Checkpoint</th><th className="num">Anchored at</th>
                    <th>Status</th><th>Detail</th><th className="num">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {verification.checkpoints.slice(0, 10).map((checkpoint) => (
                    <tr key={checkpoint.id}>
                      <td className="mono nowrap">{checkpoint.id.slice(0, 16)}…</td>
                      <td className="num">seq {checkpoint.seq}</td>
                      <td>
                        <span className={`pill ${checkpoint.status === 'valid' ? 'pill-pass' : 'pill-block'}`}>
                          {checkpoint.status}
                        </span>
                      </td>
                      <td className="muted" style={{ maxWidth: 420 }}>{checkpoint.detail}</td>
                      <td className="num faint nowrap">{formatDateTime(checkpoint.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Recent events" hint={`${events.length} shown, newest first`}>
          {events.length === 0 ? (
            <Empty title="The chain is empty" hint="No events have been recorded yet." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="num">Seq</th><th>Event</th><th>Actor</th>
                    <th>Subject</th><th>Prev hash</th><th>Hash</th>
                    <th className="num">When</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id}>
                      <td className="num faint">{event.seq}</td>
                      <td className="mono nowrap"><strong>{event.eventType}</strong></td>
                      <td className="mono nowrap faint">
                        {event.actorId ?? event.actorKind}
                      </td>
                      <td className="mono nowrap faint">
                        {event.subjectKind}/{event.subjectId.slice(0, 18)}
                      </td>
                      <td><Hash value={event.prevHash} /></td>
                      <td><Hash value={event.hash} /></td>
                      <td className="num faint nowrap">{formatDateTime(event.occurredAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Never suppressed, never collapsed, never below the fold on its own. */}
        <div className="caveat">
          <strong>Tamper-evident, not tamper-proof.</strong> {verification.limitation}
          <br /><br />
          To see this fail on purpose, run{' '}
          <code>npm run demo:tamper -w apps/api</code>. It shows the application
          role being refused, the database <em>owner</em> being refused, and then
          a privileged insider disabling the append-only trigger — owner-only DDL
          that PostgreSQL logs — before the edit succeeds and this page turns red.
        </div>
      </div>
    </>
  );
}
