import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The pieces of the OAuth consent round-trip that are worth testing.
 *
 * The Next.js route that uses these is deliberately thin. Everything with a
 * decision in it — is this state genuine, did the user decline, is this string
 * a code or a whole URL — lives here, where it runs under the test suite
 * instead of only under a browser.
 */

/** Long enough that guessing is hopeless; buildAuthorizationUrl demands >= 16. */
const STATE_BYTES = 32;

export function createOAuthState(): string {
  return randomBytes(STATE_BYTES).toString('base64url');
}

/**
 * Compare the state we issued against the one that came back.
 *
 * Constant-time, and empty values never match. An attacker who can make the
 * admin's browser hit the callback with a code of the attacker's choosing gets
 * the seller account bound to *their* eBay account, so this comparison is the
 * whole defence and it must not have a shortcut.
 */
export function verifyState(
  expected: string | undefined | null,
  received: string | undefined | null,
): boolean {
  if (!expected || !received) return false;

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Hashing to a fixed width first is overkill here: the state is always the
  // same length by construction, so a differing length is already a failure.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type CallbackResult =
  | { kind: 'CODE'; code: string; state: string | null }
  | { kind: 'DECLINED' }
  | { kind: 'ERROR'; error: string; description: string | null };

/**
 * Interpret whatever eBay sent to the redirect URL.
 *
 * Three genuinely different outcomes, and collapsing them loses information the
 * admin needs: a decline is a decision, an error is a misconfiguration, and
 * only one of the three is worth retrying blindly.
 */
export function parseCallbackParams(params: URLSearchParams): CallbackResult {
  // Our own declined URL carries this. eBay also sends error=access_denied.
  if (params.get('declined') === '1') return { kind: 'DECLINED' };

  const error = params.get('error');
  if (error) {
    if (error === 'access_denied') return { kind: 'DECLINED' };
    return { kind: 'ERROR', error, description: params.get('error_description') };
  }

  const code = params.get('code');
  if (!code) {
    return {
      kind: 'ERROR',
      error: 'missing_code',
      description: 'the callback carried neither a code nor an error',
    };
  }

  return { kind: 'CODE', code, state: params.get('state') };
}

/**
 * Pull the authorization code out of whatever the admin pasted.
 *
 * This exists because eBay often refuses to register an http://localhost
 * redirect, so the practical flow becomes "consent, then copy the address bar".
 * What lands in the paste box is therefore one of: the entire redirect URL, a
 * bare code, or a bare code still percent-encoded from the address bar.
 */
export function extractAuthorizationCode(pasted: string): string | null {
  const trimmed = pasted.trim();
  if (!trimmed) return null;

  let candidate = trimmed;

  // A whole URL: let the URL parser do the decoding.
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    const code = url.searchParams.get('code');
    return code && code.length > 0 ? code : null;
  }

  // A "code=..." fragment copied without the rest of the URL.
  const prefixed = /^code=(.+)$/is.exec(candidate);
  if (prefixed) candidate = prefixed[1]!;

  // Percent-decode only if it still looks encoded. eBay codes contain '^' and
  // '#' but never a literal '%', so a '%' means we are looking at the raw
  // address-bar form. Decoding unconditionally would corrupt an already-decoded
  // code the moment eBay changes its alphabet.
  if (candidate.includes('%')) {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      // Malformed escape: keep the original rather than losing the value.
    }
  }

  candidate = candidate.trim();
  return candidate.length > 0 ? candidate : null;
}

/**
 * Which of the scopes we asked for did eBay actually grant?
 *
 * eBay silently drops scopes a keyset is not entitled to, so a token can come
 * back looking healthy and then fail every inventory call. Naming the gap at
 * connection time turns that into one clear message instead of a 403 during a
 * publish.
 */
export function missingScopes(granted: readonly string[], required: readonly string[]): string[] {
  const have = new Set(granted);
  return required.filter((scope) => !have.has(scope));
}
