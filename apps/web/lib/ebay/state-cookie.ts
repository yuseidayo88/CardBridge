import 'server-only';

/**
 * The CSRF state cookie for the eBay consent round-trip.
 *
 * Its own module so the route handler and the server action cannot drift apart
 * on the name or the attributes — two places setting and reading "the same"
 * cookie by copy-paste is how a `secure` flag ends up on one side only.
 */

export const OAUTH_STATE_COOKIE = 'cb_ebay_oauth_state';

/** Consent is a one-sitting operation; ten minutes is generous. */
export const OAUTH_STATE_MAX_AGE_SECONDS = 600;

export function stateCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    // Lax, not Strict: the browser arrives here via a top-level redirect from
    // eBay's domain, and Strict would withhold the cookie on exactly that
    // navigation — the flow would fail state verification every single time.
    sameSite: 'lax',
    // Sandbox development runs on http://localhost, where a secure cookie is
    // never sent back. Keyed off the app URL rather than NODE_ENV so a local
    // production build still works.
    secure: (process.env.APP_URL ?? 'http://localhost:3000').startsWith('https://'),
    path: '/',
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
  };
}
