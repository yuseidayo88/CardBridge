import { describe, expect, it } from 'vitest';
import {
  createOAuthState,
  extractAuthorizationCode,
  missingScopes,
  parseCallbackParams,
  verifyState,
} from './connect-flow';
import { REQUIRED_SCOPES } from './oauth';

/** A realistic eBay authorization code, in its decoded form. */
const REAL_CODE = 'v^1.1#i^1#f^0#I^3#r^1#p^3#t^Ul4xMF8xMDpDNkE=';
/** The same code as it appears in a browser address bar. */
const ENCODED_CODE = 'v%5E1.1%23i%5E1%23f%5E0%23I%5E3%23r%5E1%23p%5E3%23t%5EUl4xMF8xMDpDNkE%3D';

describe('OAuth state', () => {
  it('generates a state long enough for buildAuthorizationUrl to accept', () => {
    expect(createOAuthState().length).toBeGreaterThanOrEqual(16);
  });

  it('generates a different state every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => createOAuthState()));
    expect(seen.size).toBe(50);
  });

  it('produces URL-safe states, so the round trip cannot mangle them', () => {
    for (let i = 0; i < 20; i += 1) {
      const state = createOAuthState();
      expect(encodeURIComponent(state)).toBe(state);
    }
  });

  it('accepts a state that matches', () => {
    const state = createOAuthState();
    expect(verifyState(state, state)).toBe(true);
  });

  it('rejects a state that differs', () => {
    expect(verifyState(createOAuthState(), createOAuthState())).toBe(false);
  });

  it('rejects a state of the right length but wrong content', () => {
    const state = createOAuthState();
    const tampered = `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`;
    expect(tampered.length).toBe(state.length);
    expect(verifyState(state, tampered)).toBe(false);
  });

  // The dangerous failure is not "wrong state rejected" but "no state accepted":
  // if a missing cookie compared equal to a missing parameter, the CSRF defence
  // would vanish exactly when it is under attack.
  it.each([
    ['both empty', '', ''],
    ['both undefined', undefined, undefined],
    ['both null', null, null],
    ['expected missing', undefined, 'something'],
    ['received missing', 'something', undefined],
  ])('rejects when %s', (_label, expected, received) => {
    expect(verifyState(expected, received)).toBe(false);
  });
});

describe('callback interpretation', () => {
  it('reads a code and its state', () => {
    const result = parseCallbackParams(new URLSearchParams({ code: REAL_CODE, state: 'abc' }));
    expect(result).toEqual({ kind: 'CODE', code: REAL_CODE, state: 'abc' });
  });

  it('treats our own declined URL as a decline', () => {
    expect(parseCallbackParams(new URLSearchParams({ declined: '1' })).kind).toBe('DECLINED');
  });

  it("treats eBay's access_denied as a decline, not an error", () => {
    expect(parseCallbackParams(new URLSearchParams({ error: 'access_denied' })).kind).toBe(
      'DECLINED',
    );
  });

  it('keeps eBay error details rather than flattening them', () => {
    const result = parseCallbackParams(
      new URLSearchParams({ error: 'invalid_scope', error_description: 'scope not permitted' }),
    );
    expect(result).toEqual({
      kind: 'ERROR',
      error: 'invalid_scope',
      description: 'scope not permitted',
    });
  });

  it('reports a callback carrying neither code nor error', () => {
    const result = parseCallbackParams(new URLSearchParams());
    expect(result.kind).toBe('ERROR');
  });

  it('does not mistake a decline for a code', () => {
    // A decline that also carried a stale code must still be a decline.
    const result = parseCallbackParams(new URLSearchParams({ declined: '1', code: REAL_CODE }));
    expect(result.kind).toBe('DECLINED');
  });
});

describe('pasted code extraction', () => {
  it('takes the code out of a full redirect URL', () => {
    const url = `http://localhost:3000/api/ebay/callback?code=${ENCODED_CODE}&expires_in=299&state=xyz`;
    expect(extractAuthorizationCode(url)).toBe(REAL_CODE);
  });

  it('accepts a bare decoded code unchanged', () => {
    expect(extractAuthorizationCode(REAL_CODE)).toBe(REAL_CODE);
  });

  it('decodes a bare code copied straight from the address bar', () => {
    expect(extractAuthorizationCode(ENCODED_CODE)).toBe(REAL_CODE);
  });

  it('accepts a "code=" fragment', () => {
    expect(extractAuthorizationCode(`code=${ENCODED_CODE}`)).toBe(REAL_CODE);
  });

  it('tolerates surrounding whitespace and newlines', () => {
    expect(extractAuthorizationCode(`\n  ${REAL_CODE}  \n`)).toBe(REAL_CODE);
  });

  // A decoded code contains '^' and '#' but no '%'. Decoding it a second time
  // would be silent corruption, and the resulting failure — a rejected code
  // that looks correct in the logs — is miserable to diagnose.
  it('does not double-decode an already-decoded code', () => {
    expect(extractAuthorizationCode(REAL_CODE)).toBe(REAL_CODE);
    expect(extractAuthorizationCode(extractAuthorizationCode(ENCODED_CODE)!)).toBe(REAL_CODE);
  });

  it('keeps the value when the percent escape is malformed', () => {
    expect(extractAuthorizationCode('abc%zz')).toBe('abc%zz');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   \n '],
    ['a URL with no code', 'http://localhost:3000/api/ebay/callback?state=xyz'],
  ])('returns null for %s', (_label, input) => {
    expect(extractAuthorizationCode(input)).toBeNull();
  });

  it('returns null for something that only looks like a URL', () => {
    expect(extractAuthorizationCode('http://[not a url')).toBeNull();
  });
});

describe('granted scopes', () => {
  it('reports nothing missing when every required scope was granted', () => {
    expect(missingScopes([...REQUIRED_SCOPES], REQUIRED_SCOPES)).toEqual([]);
  });

  it('names the scopes eBay silently dropped', () => {
    const granted = REQUIRED_SCOPES.filter((s) => !s.endsWith('sell.inventory'));
    expect(missingScopes(granted, REQUIRED_SCOPES)).toEqual([
      'https://api.ebay.com/oauth/api_scope/sell.inventory',
    ]);
  });

  it('ignores extra scopes eBay threw in', () => {
    const granted = [...REQUIRED_SCOPES, 'https://api.ebay.com/oauth/api_scope/sell.marketing'];
    expect(missingScopes(granted, REQUIRED_SCOPES)).toEqual([]);
  });
});
