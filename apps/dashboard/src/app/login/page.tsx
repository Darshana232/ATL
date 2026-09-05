import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { apiBaseUrl, currentPrincipal, SESSION_COOKIE } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Sign in.
 *
 * A SERVER ACTION does the work, so the password is posted to our own server
 * and forwarded from there. It never appears in client-side JavaScript, and
 * there is no fetch from the browser to the API that could be intercepted by
 * an XSS payload on this page.
 *
 * The session cookie is set with `httpOnly`, so the same XSS payload cannot
 * read it afterwards either.
 */
async function signIn(formData: FormData): Promise<void> {
  'use server';

  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  const response = await fetch(`${apiBaseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
    cache: 'no-store',
  });

  if (!response.ok) {
    // The API deliberately returns one message for "no such account", "wrong
    // password" and "suspended account", so this cannot become a user
    // enumeration oracle. We pass it through unchanged rather than trying to
    // be more helpful, because being more helpful is the bug.
    redirect('/login?error=1');
  }

  // Read the API's Set-Cookie and re-issue it on OUR domain. The console and
  // the API are separate deployables (ADR-0002), so the browser must hold a
  // cookie for the console's origin.
  const setCookie = response.headers.get('set-cookie') ?? '';
  const token = /atl_session=([^;]+)/.exec(setCookie)?.[1] ?? '';

  const body = (await response.json()) as { expiresAt: string };
  const jar = await cookies();

  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    expires: new Date(body.expiresAt),
  });

  redirect('/');
}

async function signOut(): Promise<void> {
  'use server';

  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;

  if (token !== undefined) {
    // Revoke server-side too. Deleting only the browser cookie would leave a
    // live session anybody holding the token could still use.
    await fetch(`${apiBaseUrl}/v1/auth/logout`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
      cache: 'no-store',
    }).catch(() => undefined);
  }

  jar.delete(SESSION_COOKIE);
  redirect('/login');
}

export default async function LoginPage(
  { searchParams }: { searchParams: Promise<{ error?: string }> },
) {
  const params = await searchParams;
  const principal = await currentPrincipal();

  return (
    <div style={{ maxWidth: 420 }}>
      <header className="page-header">
        <h1 className="page-title">Sign in</h1>
        <p className="page-sub">
          Console access is per operator, with a role. Every action you take is
          recorded against your account.
        </p>
      </header>

      {principal !== null && principal.verifiedIdentity && (
        <div className="banner banner-ok" style={{ marginBottom: 14 }}>
          <div className="banner-title">Signed in as {principal.displayName}</div>
          Role: <strong>{principal.role}</strong>
          <form action={signOut} style={{ marginTop: 10 }}>
            <button className="btn" type="submit">Sign out</button>
          </form>
        </div>
      )}

      {principal !== null && !principal.verifiedIdentity && (
        <div className="banner banner-warn" style={{ marginBottom: 14 }}>
          <div className="banner-title">Using the shared admin key</div>
          No verified identity is being recorded for anything you do. Sign in
          with an operator account to fix that.
        </div>
      )}

      {params.error !== undefined && (
        <div className="banner banner-error" style={{ marginBottom: 14 }}>
          That email and password do not match an active account.
        </div>
      )}

      <div className="card">
        <div className="card-body">
          <form action={signIn} className="stack">
            <label>
              <div className="metric-label">Email</div>
              <input
                className="btn" style={{ width: '100%', marginTop: 4 }}
                type="email" name="email" required autoComplete="username"
              />
            </label>
            <label>
              <div className="metric-label">Password</div>
              <input
                className="btn" style={{ width: '100%', marginTop: 4 }}
                type="password" name="password" required autoComplete="current-password"
              />
            </label>
            <button className="btn btn-primary" type="submit">Sign in</button>
          </form>
        </div>
      </div>

      <div className="caveat">
        <strong>Development fixtures.</strong> <code>npm run seed -w apps/api</code>{' '}
        creates three accounts, one per role:{' '}
        <code>admin@atl.example</code>, <code>compliance@atl.example</code> and{' '}
        <code>viewer@atl.example</code>. Their passwords are in{' '}
        <code>apps/api/src/db/seed.ts</code> — acceptable only because they are
        fixtures in a script a production deployment never runs.
      </div>
    </div>
  );
}
