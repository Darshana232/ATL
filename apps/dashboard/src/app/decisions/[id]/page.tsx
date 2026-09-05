import Link from 'next/link';
import { apiGet, formatDateTime, formatPaise } from '@/lib/api';
import type { DecisionDetail } from '@/lib/types';
import { ApiFailure, Banner, Card, Verdict } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * One decision, in full.
 *
 * THIS SCREEN IS THE PRODUCT. Everything else in the console is navigation to
 * get here.
 *
 * It answers "why?" completely: which rules ran, in what order, what each one
 * observed, what it expected, and the sentence it produced. Including the ones
 * that passed — "did you check the merchant?" is exactly what an auditor asks,
 * and a screen that shows only failures cannot answer it.
 */
export default async function DecisionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let decision: DecisionDetail;
  try {
    decision = await apiGet<DecisionDetail>(`/v1/console/decisions/${encodeURIComponent(id)}`);
  } catch (error) {
    return <ApiFailure error={error} />;
  }

  const blocking = decision.evaluations.filter((rule) => rule.verdict === 'BLOCK');
  const ran = decision.evaluations.filter((rule) => rule.verdict !== 'SKIP');

  return (
    <>
      <header className="page-header">
        <div className="row">
          <h1 className="page-title">Decision</h1>
          <Verdict value={decision.verdict} />
          <span className="mono faint">{decision.id}</span>
        </div>
        <p className="page-sub">{decision.reason}</p>
      </header>

      <div className="stack">
        {blocking.length > 1 && (
          <Banner kind="warn" title={`${blocking.length} rules blocked this request`}>
            The headline reason is the first blocking rule. Every rule still ran,
            so the user sees all of them at once rather than discovering them one
            failed retry at a time.
          </Banner>
        )}

        <Card title="Request">
          <div className="card-body">
            <table>
              <tbody>
                <tr><td className="faint">Agent</td><td className="mono">{decision.agentId}</td></tr>
                <tr><td className="faint">Mandate</td><td className="mono">
                  <Link href="/mandates">{decision.mandateId}</Link> · version {decision.mandateVersion}
                </td></tr>
                <tr><td className="faint">Merchant</td><td className="mono">{decision.merchantId}</td></tr>
                <tr><td className="faint">Amount</td><td className="num" style={{ textAlign: 'left' }}>
                  <strong>{formatPaise(decision.amountPaise)}</strong>
                </td></tr>
                <tr><td className="faint">Method</td><td className="mono">{decision.paymentMethod}</td></tr>
                <tr><td className="faint">Spent before</td><td className="num" style={{ textAlign: 'left' }}>
                  {formatPaise(decision.spentBeforePaise)}{' '}
                  <span className="faint">
                    in the window {formatDateTime(decision.spendWindowStart)} –{' '}
                    {formatDateTime(decision.spendWindowEnd)}
                  </span>
                </td></tr>
                <tr><td className="faint">Engine</td><td className="mono">{decision.engineVersion}</td></tr>
                <tr><td className="faint">Evaluated</td><td>
                  {formatDateTime(decision.evaluatedAt)}
                  {decision.evaluationDurationUs !== null && (
                    <span className="faint"> · {decision.evaluationDurationUs} µs</span>
                  )}
                </td></tr>
                {decision.userIntent !== null && (
                  <tr><td className="faint">User intent</td><td className="muted">
                    “{decision.userIntent}”
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card
          title="Rule breakdown"
          hint={`${ran.length} rules applied · ${decision.evaluations.length - ran.length} skipped`}
        >
          <div className="card-body">
            <div className="rules">
              {decision.evaluations.map((rule) => (
                <div
                  key={rule.ruleCode}
                  className={
                    'rule' +
                    (rule.verdict === 'BLOCK' ? ' rule-blocked'
                      : rule.verdict === 'FLAG' ? ' rule-flagged' : '')
                  }
                >
                  <div className="rule-head">
                    <span className="rule-seq">{rule.sequence}</span>
                    <span className="rule-code">{rule.ruleCode}</span>
                    <Verdict value={rule.verdict} />
                  </div>
                  <div className="rule-reason">{rule.reason}</div>
                  <div className="rule-detail">
                    observed: {rule.signal} · expected: {rule.expected} · actual: {rule.actual}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>

        <div className="caveat">
          <strong>Every reason on this page was generated by code</strong>, from
          the rule that fired — never by a language model. A model can produce
          plausible text about a decision it did not make; only the rule that
          actually ran knows the numbers.
          {decision.riskProvider !== null && (
            <>
              {' '}The risk score ({decision.riskScore}/100, provider{' '}
              <code>{decision.riskProvider}</code>) is <strong>advisory and
              simulated</strong>: it may raise a FLAG, and can never override a
              BLOCK or create a PASS.
            </>
          )}
        </div>
      </div>
    </>
  );
}
