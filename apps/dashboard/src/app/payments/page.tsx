import Link from 'next/link';
import { apiGet, formatDateTime, formatPaise } from '@/lib/api';
import type { PaymentRow } from '@/lib/types';
import { ApiFailure, Card, Empty, SimulationBadge, Status } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function PaymentsPage() {
  let payments: PaymentRow[];
  try {
    payments = (await apiGet<{ payments: PaymentRow[] }>(
      '/v1/console/payments?limit=100',
    )).payments;
  } catch (error) {
    return <ApiFailure error={error} />;
  }

  const simulated = payments.filter((payment) => payment.simulated).length;

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Payments</h1>
        <p className="page-sub">
          Every payment, each one redeeming exactly one single-use voucher minted
          by the policy engine. No voucher, no payment.
        </p>
      </header>

      {simulated > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="banner banner-info">
            <strong>{simulated} of {payments.length} payments shown are SIMULATED.</strong>{' '}
            No money moved. The provider column is recorded per row, so a report
            cannot present a simulated settlement as a real one.
          </div>
        </div>
      )}

      <Card hint={`${payments.length} shown`}>
        {payments.length === 0 ? (
          <Empty
            title="No payments yet"
            hint={<>Run <code>npm run demo:agent -w apps/api</code>.</>}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th><th>Rail</th><th>Payment</th><th>Agent</th>
                  <th>Merchant</th><th className="num">Amount</th>
                  <th>Decision</th><th>Failure</th><th className="num">Created</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id}>
                    <td><Status value={payment.status} /></td>
                    <td><SimulationBadge simulated={payment.simulated} /></td>
                    <td className="mono nowrap">{payment.id.slice(0, 16)}…</td>
                    <td className="mono nowrap faint">{payment.agentId}</td>
                    <td className="mono nowrap faint">{payment.merchantId}</td>
                    <td className="num">{formatPaise(payment.amountPaise)}</td>
                    <td className="mono nowrap">
                      <Link href={`/decisions/${payment.decisionId}`}>
                        {payment.decisionId.slice(0, 12)}…
                      </Link>
                    </td>
                    <td className="muted" style={{ maxWidth: 300, fontSize: 12 }}>
                      {payment.failureReason ?? <span className="faint">—</span>}
                    </td>
                    <td className="num faint nowrap">{formatDateTime(payment.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="caveat">
        <strong>Single use is a database constraint, not a check.</strong>{' '}
        <code>payments.voucher_jti</code> is UNIQUE, so two perfectly concurrent
        redemptions produce one payment — an application-level “have we seen this
        voucher?” loses that race. <code>payments.decision_id</code> is UNIQUE
        too, capping each authorization at one payment independently.
      </div>
    </>
  );
}
