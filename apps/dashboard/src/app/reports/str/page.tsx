import Link from 'next/link';
import { apiGet, formatDateTime, formatPaise } from '@/lib/api';
import type { StrDraft } from '@/lib/types';
import { ApiFailure, Banner, Card, Empty, Metric } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * STR drafts.
 *
 * The banner says DRAFT and says we cannot file, and it is the first thing on
 * the page rather than a footnote — because the difference between a draft and
 * a filing is a legal one, and this is the screen where somebody could
 * misunderstand it.
 */
export default async function StrPage() {
  let draft: StrDraft;
  try {
    draft = await apiGet<StrDraft>('/v1/reports/str');
  } catch (error) {
    return <ApiFailure error={error} />;
  }

  const byReason = draft.candidates.reduce<Record<string, number>>((acc, candidate) => {
    acc[candidate.reason] = (acc[candidate.reason] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Suspicious activity — DRAFT</h1>
        <p className="page-sub">
          Candidates detected deterministically from recorded decisions, for
          review by a qualified compliance officer. Period{' '}
          {formatDateTime(draft.periodStart)} – {formatDateTime(draft.periodEnd)}.
        </p>
      </header>

      <div className="stack">
        <Banner kind="error" title="DRAFT — HUMAN REVIEW REQUIRED. Nothing here has been filed.">
          <p style={{ margin: '4px 0' }}>
            FIU-IND filing is performed through the FINnet portal by{' '}
            <strong>registered reporting entities</strong> under the PMLA.
            ATL-India is <strong>{draft.reportingEntity.registrationStatus}</strong>,
            and holds <strong>{draft.reportingEntity.finnetAccess.toLowerCase()}</strong>
          </p>
          <p style={{ margin: '4px 0' }}>{draft.nextStep}</p>
        </Banner>

        <div className="metrics">
          <Metric label="Candidates" value={draft.candidateCount} note="for human review" />
          <Metric label="Status" value={draft.status} note="cannot become “filed”" />
          <Metric
            label="Detection"
            value="deterministic"
            note="stated rules, not a model — reproducible for a reviewer"
          />
        </div>

        {Object.keys(byReason).length > 0 && (
          <Card title="By detection reason">
            <div className="card-body">
              <div className="row">
                {Object.entries(byReason).map(([reason, count]) => (
                  <span key={reason} className="pill pill-flag">{reason} · {count}</span>
                ))}
              </div>
            </div>
          </Card>
        )}

        <Card title="Candidates" hint="newest first">
          {draft.candidates.length === 0 ? (
            <Empty
              title="No candidates in this period"
              hint="No decisions tripped a detection rule. This is not a clean bill of health — it is an absence of matches."
            />
          ) : (
            <div className="card-body stack">
              {draft.candidates.slice(0, 60).map((candidate, index) => (
                <div key={`${candidate.reason}-${index}`} className="control-row">
                  <div>
                    <div className="control-title">{candidate.title}</div>
                    <div className="control-desc">{candidate.narrative}</div>
                    <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
                      {formatDateTime(candidate.occurredAt)}
                      {candidate.amountPaise !== null && <> · {formatPaise(candidate.amountPaise)}</>}
                      {candidate.decisionId !== null && (
                        <> · <Link href={`/decisions/${candidate.decisionId}`}>
                          {candidate.decisionId.slice(0, 14)}…
                        </Link></>
                      )}
                    </div>
                  </div>
                  <span className="pill pill-flag">{candidate.reason}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="caveat">
          <strong>The workflow stops one step short of filing, on purpose.</strong>{' '}
          {draft.caveat}
        </div>
      </div>
    </>
  );
}
