import { decryptToken, encryptToken } from './token-crypto';
// EbayEnvironment has one definition, in the guard: two enums that must agree
// but are declared separately are two enums that will eventually disagree.
import type { EbayEnvironment } from '../guard/dry-run-guard';

/**
 * eBay OAuth.
 *
 * Two grant types, used for different things:
 *
 *   - Client credentials produce an *application* token. Metadata API calls
 *     (categories, condition policies, item aspects) use this, so the nightly
 *     metadata refresh needs no user consent and cannot be broken by a
 *     seller's session expiring.
 *
 *   - Authorization code produces a *user* token. Anything that touches the
 *     seller's inventory needs this.
 *
 * Access tokens are refreshed proactively rather than on 401. Discovering
 * expiry through a failed publish means an unnecessary failure in the one
 * operation that matters most.
 */

const ENDPOINTS: Record<EbayEnvironment, { auth: string; api: string }> = {
  SANDBOX: {
    auth: 'https://auth.sandbox.ebay.com/oauth2/authorize',
    api: 'https://api.sandbox.ebay.com',
  },
  PRODUCTION: {
    auth: 'https://auth.ebay.com/oauth2/authorize',
    api: 'https://api.ebay.com',
  },
};

/**
 * Scopes this application requests.
 *
 * Marketplace Insights is deliberately absent: it is a Limited Release that is
 * not open to new applicants, and requesting a scope we cannot use only makes
 * the consent screen more alarming than it needs to be.
 */
export const REQUIRED_SCOPES = [
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
] as const;

/** Metadata calls need only this. */
export const APPLICATION_SCOPES = ['https://api.ebay.com/oauth/api_scope'] as const;

export interface OAuthConfig {
  environment: EbayEnvironment;
  appId: string;
  certId: string;
  /** The RuName, not a URL. */
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date | null;
  scopes: string[];
}

export interface StoredCredentials {
  refreshTokenEnc: string;
  accessTokenEnc: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scopes: string[];
}

export class EbayAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly ebayError?: unknown,
  ) {
    super(message);
    this.name = 'EbayAuthError';
  }
}

/** Refresh this long before actual expiry, so a long job cannot expire mid-run. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export class EbayOAuthClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OAuthConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get apiBaseUrl(): string {
    return ENDPOINTS[this.config.environment].api;
  }

  /** Basic auth header for the token endpoint. */
  private basicAuth(): string {
    const raw = `${this.config.appId}:${this.config.certId}`;
    return `Basic ${Buffer.from(raw).toString('base64')}`;
  }

  /**
   * The URL to send an admin to in order to grant access.
   *
   * `state` is required, not optional: without it the callback cannot tell a
   * genuine redirect from a forged one, which is a CSRF hole in the one flow
   * that hands out inventory write access.
   */
  buildAuthorizationUrl(state: string): string {
    if (!state || state.length < 16) {
      throw new EbayAuthError('state must be at least 16 characters of unguessable randomness');
    }

    const url = new URL(ENDPOINTS[this.config.environment].auth);
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', REQUIRED_SCOPES.join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  }

  private async requestToken(body: URLSearchParams): Promise<TokenSet> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: this.basicAuth(),
      },
      body: body.toString(),
    });

    const text = await response.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new EbayAuthError(
        `token endpoint returned non-JSON: ${text.slice(0, 200)}`,
        response.status,
      );
    }

    if (!response.ok) {
      // The description is eBay's; the token itself is never echoed here.
      const description = String(payload.error_description ?? payload.error ?? 'unknown error');
      throw new EbayAuthError(`token request failed: ${description}`, response.status, payload);
    }

    const accessToken = String(payload.access_token ?? '');
    if (!accessToken) {
      throw new EbayAuthError('token response contained no access_token', response.status, payload);
    }

    const expiresIn = Number(payload.expires_in ?? 7200);
    const refreshExpiresIn = payload.refresh_token_expires_in
      ? Number(payload.refresh_token_expires_in)
      : null;

    return {
      accessToken,
      refreshToken: payload.refresh_token ? String(payload.refresh_token) : null,
      accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
      refreshTokenExpiresAt: refreshExpiresIn
        ? new Date(Date.now() + refreshExpiresIn * 1000)
        : null,
      scopes: String(payload.scope ?? '')
        .split(' ')
        .filter(Boolean),
    };
  }

  /** Exchange the one-time code from the callback for a token set. */
  async exchangeCode(code: string): Promise<TokenSet> {
    return this.requestToken(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.redirectUri,
      }),
    );
  }

  async refreshUserToken(refreshToken: string): Promise<TokenSet> {
    const result = await this.requestToken(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: REQUIRED_SCOPES.join(' '),
      }),
    );
    // eBay does not return the refresh token on a refresh; keep the one we have.
    return { ...result, refreshToken: result.refreshToken ?? refreshToken };
  }

  /** Application token for Metadata calls. No user consent involved. */
  async getApplicationToken(): Promise<TokenSet> {
    return this.requestToken(
      new URLSearchParams({
        grant_type: 'client_credentials',
        scope: APPLICATION_SCOPES.join(' '),
      }),
    );
  }
}

export function isAccessTokenUsable(credentials: StoredCredentials): boolean {
  if (!credentials.accessTokenEnc || !credentials.accessTokenExpiresAt) return false;
  return credentials.accessTokenExpiresAt.getTime() - EXPIRY_MARGIN_MS > Date.now();
}

export function isRefreshTokenExpired(credentials: StoredCredentials): boolean {
  if (!credentials.refreshTokenExpiresAt) return false;
  return credentials.refreshTokenExpiresAt.getTime() <= Date.now();
}

export function toStoredCredentials(tokens: TokenSet, key?: string): StoredCredentials {
  if (!tokens.refreshToken) {
    throw new EbayAuthError('cannot store credentials without a refresh token');
  }
  return {
    refreshTokenEnc: encryptToken(tokens.refreshToken, key),
    accessTokenEnc: encryptToken(tokens.accessToken, key),
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    scopes: tokens.scopes,
  };
}

/**
 * Produce a usable access token, refreshing if needed.
 *
 * `persist` is called only when a refresh actually happened, so a read-only
 * caller does not write to the database on every request.
 */
export async function ensureAccessToken(
  client: EbayOAuthClient,
  credentials: StoredCredentials,
  persist: (updated: StoredCredentials) => Promise<void>,
  key?: string,
): Promise<string> {
  if (isRefreshTokenExpired(credentials)) {
    throw new EbayAuthError(
      'the refresh token has expired; an admin must re-authorise the application',
    );
  }

  if (isAccessTokenUsable(credentials)) {
    return decryptToken(credentials.accessTokenEnc!, key);
  }

  const refreshed = await client.refreshUserToken(decryptToken(credentials.refreshTokenEnc, key));
  const updated = toStoredCredentials(refreshed, key);
  await persist(updated);
  return refreshed.accessToken;
}
