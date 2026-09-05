/**
 * The one place the dashboard talks to the API.
 *
 * THE ADMIN KEY NEVER REACHES THE BROWSER. Every call here runs in a React
 * Server Component or a Server Action, so the key stays in the Node process.
 * `ATL_ADMIN_KEY` deliberately has no `NEXT_PUBLIC_` prefix - Next.js refuses
 * to expose it to the client, which turns a discipline into a build-time
 * guarantee.
 *
 * The dashboard holds no database credentials and re-implements no policy
 * logic. It renders what the API says. The one thing it must never do is
 * compute a compliance figure of its own.
 */
const API_BASE = process.env.ATL_API_BASE_URL ?? 'http://127.0.0.1:8080';
const ADMIN_KEY = process.env.ATL_ADMIN_KEY ?? '';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * `no-store` on every read.
 *
 * A compliance console showing a cached audit-integrity result is worse than
 * one showing nothing: it would report VERIFIED for a chain that broke five
 * minutes ago. Freshness matters more than latency on every screen here.
 */
export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: ADMIN_KEY === '' ? {} : { 'x-atl-admin-key': ADMIN_KEY },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new ApiError(
      response.status,
      response.status === 401
        ? 'The API rejected the console credentials. Is ATL_ADMIN_KEY set correctly?'
        : `The API returned ${response.status} for ${path}.`,
    );
  }

  return (await response.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ADMIN_KEY === '' ? {} : { 'x-atl-admin-key': ADMIN_KEY }),
    },
    body: JSON.stringify(body ?? {}),
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new ApiError(response.status, `The API returned ${response.status} for ${path}.`);
  }

  return (await response.json()) as T;
}

/**
 * Formatting money for display.
 *
 * Presentation only. The API returns integer paise and never a formatted
 * string, because formatting is locale-dependent and a number that has been
 * through a formatter cannot be added up again.
 */
export function formatPaise(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const absolute = Math.abs(paise);
  const rupees = Math.trunc(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, '0');

  // Indian digit grouping: last three digits, then pairs. 1234567 -> 12,34,567.
  const digits = String(rupees);
  const head = digits.length > 3 ? digits.slice(0, -3) : '';
  const tail = digits.slice(-3);
  const grouped = head === ''
    ? tail
    : `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;

  return `${sign}₹${grouped}.${remainder}`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
  });
}

export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
