import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import {
  EbayAuthError,
  REQUIRED_SCOPES,
  missingScopes,
  parseCallbackParams,
  toStoredCredentials,
  verifyState,
} from '@cardbridge/ebay';
import { getAdminIdentity } from '@/lib/auth/require-admin';
import { createUserOAuthClient, readEbayConfig } from '@/lib/ebay/config';
import { saveCredentials } from '@/lib/ebay/credentials';
import { OAUTH_STATE_COOKIE } from '@/lib/ebay/state-cookie';

/**
 * Where eBay sends the admin back after they grant (or refuse) access.
 *
 * The order of the checks is the point. Admin session first, then state, then
 * the code — so a forged callback is rejected before its code is ever offered
 * to eBay's token endpoint. Exchanging first and asking questions afterwards
 * would mean an attacker's authorization code could be swapped for tokens and
 * written over the real seller's row.
 */

const SETTINGS_PATH = '/settings/ebay';

function back(request: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL(SETTINGS_PATH, request.nextUrl.origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const admin = await getAdminIdentity();
  if (!admin) {
    return NextResponse.redirect(new URL('/login', request.nextUrl.origin));
  }

  const jar = await cookies();
  const expectedState = jar.get(OAUTH_STATE_COOKIE)?.value;

  // One-shot: the state is consumed whatever the outcome, so a captured
  // callback URL cannot be replayed.
  const clearState = (response: NextResponse): NextResponse => {
    response.cookies.delete(OAUTH_STATE_COOKIE);
    return response;
  };

  const result = parseCallbackParams(request.nextUrl.searchParams);

  if (result.kind === 'DECLINED') {
    return clearState(back(request, { error: 'declined' }));
  }

  if (result.kind === 'ERROR') {
    return clearState(
      back(request, {
        error: 'ebay',
        detail: result.description ?? result.error,
      }),
    );
  }

  if (!verifyState(expectedState, result.state)) {
    // Deliberately vague to the browser, because the two causes — an expired
    // session and an actual forgery — should not be distinguishable by whoever
    // triggered it.
    return clearState(back(request, { error: 'state' }));
  }

  const config = readEbayConfig();

  try {
    const client = createUserOAuthClient();
    const tokens = await client.exchangeCode(result.code);

    const absent = missingScopes(tokens.scopes, REQUIRED_SCOPES);
    if (absent.length > 0) {
      // The token is real but useless for listing. Storing it would produce a
      // screen that says "connected" and a publish that fails with 403.
      return clearState(
        back(request, {
          error: 'scopes',
          detail: absent.join(' '),
        }),
      );
    }

    await saveCredentials(config.environment, toStoredCredentials(tokens));
    return clearState(back(request, { connected: '1' }));
  } catch (error) {
    const detail =
      error instanceof EbayAuthError || error instanceof Error
        ? error.message
        : 'unknown error during token exchange';
    return clearState(back(request, { error: 'exchange', detail }));
  }
}
