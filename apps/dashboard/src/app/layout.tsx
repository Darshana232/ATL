import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { currentPrincipal } from '@/lib/api';

export const metadata: Metadata = {
  title: 'ATL-India Console',
  description:
    'Agentic Trust & Compliance Layer — authorization, audit and compliance ' +
    'evidence for agent-initiated payments. Demonstration implementation.',
};

/**
 * Navigation, grouped by the question each screen answers.
 *
 * Not alphabetical and not by data model. Somebody arrives here asking one of
 * three things - "what is happening?", "who is allowed to do what?", or "can I
 * prove it?" - and the grouping answers that before they read a label.
 */
const NAV = [
  {
    label: 'Operations',
    items: [
      { href: '/', text: 'Overview' },
      { href: '/decisions', text: 'Decisions' },
      { href: '/payments', text: 'Payments' },
      { href: '/risk', text: 'Risk signals' },
    ],
  },
  {
    label: 'Authority',
    items: [
      { href: '/mandates', text: 'Mandates' },
      { href: '/agents', text: 'Agent registry' },
    ],
  },
  {
    label: 'Evidence',
    items: [
      { href: '/audit', text: 'Audit trail' },
      { href: '/reports/free-ai', text: 'FREE-AI coverage' },
      { href: '/reports/str', text: 'STR drafts' },
      { href: '/reports/dpdp', text: 'DPDP register' },
    ],
  },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const principal = await currentPrincipal();

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="sidebar">
            <div className="brand">
              <div className="brand-name">ATL-India</div>
              <div className="brand-sub">Agentic Trust &amp; Compliance Layer</div>
            </div>

            {NAV.map((group) => (
              <div className="nav-group" key={group.label}>
                <div className="nav-label">{group.label}</div>
                {group.items.map((item) => (
                  <Link className="nav-item" href={item.href} key={item.href}>
                    {item.text}
                  </Link>
                ))}
              </div>
            ))}

            {/*
              Who the console is acting as.
              A shared key means NO verified identity is recorded for anything
              done through it, and that has to be visible rather than inferred.
            */}
            <div className="nav-group">
              <div className="nav-label">Signed in</div>
              {principal === null ? (
                <Link className="nav-item" href="/login">Sign in →</Link>
              ) : principal.verifiedIdentity ? (
                <div style={{ padding: '0 10px' }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{principal.displayName}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                    role: {principal.role}
                  </div>
                  <Link className="nav-item" href="/login" style={{ padding: '4px 0' }}>
                    Switch or sign out
                  </Link>
                </div>
              ) : (
                <div style={{ padding: '0 10px' }}>
                  <span className="pill pill-flag">shared key</span>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>
                    No verified identity is being recorded.
                  </div>
                  <Link className="nav-item" href="/login" style={{ padding: '4px 0' }}>
                    Sign in properly →
                  </Link>
                </div>
              )}
            </div>

            {/*
              The standing disclaimer, in the chrome rather than on a page.
              It is visible in every screenshot of every screen, which is the
              only placement that actually works.
            */}
            <div className="nav-group">
              <div className="caveat" style={{ margin: '8px 0 0', fontSize: 11 }}>
                <strong>Demonstration implementation.</strong> The mandate rail is
                an MVP simulation. Not an RBI, NPCI or FIU-IND integration.
              </div>
            </div>
          </nav>

          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
