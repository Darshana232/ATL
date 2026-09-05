/**
 * Shared presentation components.
 *
 * Deliberately small and unclever. A design system for a nine-screen console
 * should be a handful of components, not a framework - every abstraction here
 * has to earn itself against "just write the markup twice".
 */
import type { ReactNode } from 'react';

/* ------------------------------------------------------------------------ */

export function Verdict({ value }: { value: string }) {
  const cls =
    value === 'PASS' ? 'pill-pass'
    : value === 'FLAG' ? 'pill-flag'
    : value === 'BLOCK' ? 'pill-block'
    : 'pill-skip';

  return <span className={`pill ${cls}`}>{value}</span>;
}

/**
 * The SIMULATED badge.
 *
 * Rendered from the API's own `simulated` field, never inferred in the UI. A
 * screenshot must be unable to present a simulated settlement as a real one
 * (CLAUDE.md section 33), and that guarantee is worth nothing if the flag is
 * computed in two places that can disagree.
 */
export function SimulationBadge({ simulated }: { simulated: boolean }) {
  return simulated
    ? <span className="pill pill-sim" title="No real money moved.">SIMULATED</span>
    : <span className="pill pill-info" title="Razorpay test mode: a real API, no real money.">TEST MODE</span>;
}

export function Status({ value }: { value: string }) {
  const cls =
    value === 'captured' || value === 'active' || value === 'intact' ? 'pill-pass'
    : value === 'failed' || value === 'revoked' || value === 'broken' ? 'pill-block'
    : value === 'authorized' || value === 'created' ? 'pill-info'
    : 'pill-skip';

  return <span className={`pill ${cls}`}>{value}</span>;
}

/* ------------------------------------------------------------------------ */

export function Card(
  { title, hint, children }: { title?: string; hint?: ReactNode; children: ReactNode },
) {
  return (
    <section className="card">
      {title !== undefined && (
        <div className="card-header">
          <h2 className="card-title">{title}</h2>
          {hint !== undefined && <span className="card-hint">{hint}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Metric(
  { label, value, note }: { label: string; value: ReactNode; note?: ReactNode },
) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {note !== undefined && <div className="metric-note">{note}</div>}
    </div>
  );
}

/**
 * An empty state that says WHY it is empty and what to do about it.
 *
 * "No data" is a failure of the interface, not a description of the world. On a
 * compliance console it is worse than useless: an empty audit view could mean
 * "nothing happened" or "the API is unreachable", and those demand opposite
 * responses.
 */
export function Empty(
  { title, hint }: { title: string; hint: ReactNode },
) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      <div className="empty-hint">{hint}</div>
    </div>
  );
}

/** The honesty caveat. Never visually suppressed. */
export function Caveat({ children }: { children: ReactNode }) {
  return <div className="caveat">{children}</div>;
}

export function Banner(
  { kind, title, children }:
  { kind: 'ok' | 'warn' | 'error' | 'info'; title?: string; children: ReactNode },
) {
  return (
    <div className={`banner banner-${kind}`}>
      {title !== undefined && <div className="banner-title">{title}</div>}
      <div>{children}</div>
    </div>
  );
}

/**
 * A truncated hash with the full value on hover.
 *
 * Hashes are 64 characters and nobody reads them - but they must be COPYABLE
 * and comparable, because "is this the same hash?" is a real question during an
 * investigation.
 */
export function Hash({ value, chars = 12 }: { value: string | null; chars?: number }) {
  if (value === null) return <span className="faint">—</span>;
  return <span className="chain-hash" title={value}>{value.slice(0, chars)}…</span>;
}

/** Renders an API failure without leaking anything. */
export function ApiFailure({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : 'The API could not be reached.';

  return (
    <Banner kind="error" title="Could not load this screen">
      <p style={{ margin: '4px 0' }}>{message}</p>
      <p style={{ margin: '4px 0', fontSize: 12 }}>
        Check that the API is running (<code>npm run dev</code> in{' '}
        <code>apps/api</code>) and that <code>ATL_ADMIN_KEY</code> in{' '}
        <code>apps/dashboard/.env.local</code> matches <code>ADMIN_API_KEY</code>{' '}
        in the repo-root <code>.env</code>.
      </p>
    </Banner>
  );
}
