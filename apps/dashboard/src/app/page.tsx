import Link from 'next/link';
import { apiGet, formatPaise, relativeTime } from '@/lib/api';
import type { Overview, DecisionSummary, VerificationResult } from '@/lib/types';
import { ApiFailure, Banner, Card, Empty, Metric, SimulationBadge, Verdict } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Overview.
 *
 * WHAT PROBLEM THIS SCREEN SOLVES: somebody has just opened the console and
 * needs to know, in five seconds, whether anything is wrong.
 *
 * So it leads with the two things that would be wrong - a broken audit chain
 * and blocked decisions - and only then shows volume. Most numbers on a
 * healthy day are boring, and the layout treats them that way.
 */
export default async function OverviewPage() {
  let overview: Overview;
  let recent: DecisionSummary[] = [];
  let verification: VerificationResult | null = null;

  try {
    overview = await apiGet<Overview>('/v1/console/overview');
    recent = (await apiGet<{ decisions: DecisionSummary[] }>(
      '/v1/console/decisions?limit=8',
    )).decisions;
    verification = await apiGet<VerificationResult>('/v1/audit/verify');
  } catch (error) {
    return <ApiFailure error={error} />;
  }

  const blockRate = overview.decisions.total === 0
    ? 0
    : Math.round((overview.decisions.block / overview.decisions.total) * 100);

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Overview</h1>
        <p className="page-sub">
          Authorization, payment and evidence activity across every mandate this
          deployment governs.
        </p>
      </header>

      <div className="stack">
        {/* The integrity banner leads, because it is the only thing here that
            can be catastrophically wrong. */}
        {verification.status === 'intact' ? (
          <Banner kind="ok" title="Audit integrity verified">
            {verification.eventsChecked.toLocaleString('en-IN')} events checked in{' '}
            {verification.durationMs} ms. Head hash{' '}
            <span className="mono">{verification.headHash?.slice(0, 16)}…</span>.{' '}
            <Link href="/audit">Open the audit trail →</Link>
          </Banner>
        ) : (
          <Banner kind="error" title="AUDIT INTEGRITY CHECK FAILED">
            The chain does not verify. First break at sequence{' '}
            {verification.firstBreak?.seq} ({verification.firstBreak?.kind}).{' '}
            <Link href="/audit">Investigate →</Link>
          </Banner>
        )}

        <div className="metrics">
          <Metric
            label="Decisions"
            value={overview.decisions.total.toLocaleString('en-IN')}
            note={`${overview.decisions.pass} pass · ${overview.decisions.flag} flag · ${overview.decisions.block} block`}
          />
          <Metric
            label="Blocked"
            value={`${blockRate}%`}
            note="of all authorization requests refused by policy"
          />
          <Metric
            label="Captured"
            value={formatPaise(overview.payments.capturedPaise)}
            note={
              <>
                {overview.payments.captured} payments ·{' '}
                <strong>{overview.payments.simulatedCaptured} simulated</strong>
              </>
            }
          />
          <Metric
            label="Active mandates"
            value={overview.mandates.active.toLocaleString('en-IN')}
            note={`${overview.mandates.revoked} revoked`}
          />
          <Metric
            label="Audit events"
            value={overview.audit.events.toLocaleString('en-IN')}
            note={`${overview.audit.checkpoints} signed checkpoints`}
          />
          <Metric
            label="Rejected signatures"
            value={overview.audit.authRejections.toLocaleString('en-IN')}
            note="agent authentication attempts refused"
          />
        </div>

        <Card
          title="Recent decisions"
          hint={<Link href="/decisions">View all →</Link>}
        >
          {recent.length === 0 ? (
            <Empty
              title="No decisions yet"
              hint={
                <>
                  Run <code>npm run demo:agent -w apps/api</code> to produce a
                  compliant purchase, a blocked one, and a prompt-injection
                  attempt.
                </>
              }
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Verdict</th>
                    <th>Agent</th>
                    <th>Merchant</th>
                    <th className="num">Amount</th>
                    <th>Reason</th>
                    <th>Payment</th>
                    <th className="num">When</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((decision) => (
                    <tr key={decision.id}>
                      <td><Verdict value={decision.verdict} /></td>
                      <td className="mono nowrap">{decision.agentId}</td>
                      <td className="mono nowrap">{decision.merchantId}</td>
                      <td className="num">{formatPaise(decision.amountPaise)}</td>
                      <td className="muted" style={{ maxWidth: 380 }}>
                        <Link href={`/decisions/${decision.id}`}>{decision.reason}</Link>
                      </td>
                      <td>
                        {decision.payment === null
                          ? <span className="faint">—</span>
                          : <SimulationBadge simulated={decision.payment.simulated} />}
                      </td>
                      <td className="num faint">{relativeTime(decision.evaluatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="caveat">
          <strong>What these numbers are.</strong> {overview.simulation} Every
          figure on this screen is a live database query — none is
          hand-maintained. Authorization decisions are real and deterministic;
          settlement is simulated unless a payment records{' '}
          <code>razorpay_test</code>.
        </div>
      </div>
    </>
  );
}
