'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  REQUIRED_SCOPES,
  createOAuthState,
  extractAuthorizationCode,
  missingScopes,
  toStoredCredentials,
  type TokenSet,
} from '@cardbridge/ebay';
import { requireAdmin } from '@/lib/auth/require-admin';
import {
  createApplicationOAuthClient,
  createUserOAuthClient,
  readEbayConfig,
} from '@/lib/ebay/config';
import { saveCredentials } from '@/lib/ebay/credentials';
import { OAUTH_STATE_COOKIE, stateCookieOptions } from '@/lib/ebay/state-cookie';

const SETTINGS_PATH = '/settings/ebay';

/**
 * Every action here follows the same shape: do the fallible work inside
 * try/catch, reduce it to an outcome, and redirect *after* the catch.
 *
 * That is not stylistic. Next implements redirect() by throwing NEXT_REDIRECT,
 * so a redirect called inside a try block is caught by that block's own catch —
 * the success path would be reported as a failure, and the failure message
 * would read "NEXT_REDIRECT".
 */
type Outcome = Record<string, string>;

function go(outcome: Outcome): never {
  redirect(`${SETTINGS_PATH}?${new URLSearchParams(outcome).toString()}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Prove the App ID and Cert ID work, without involving a seller.
 *
 * This is the first thing worth doing after pasting keys, because it separates
 * "the keys are wrong" from "the consent flow is wrong" — two problems that
 * otherwise present as the same dead end. The token itself is never displayed
 * or stored; only its lifetime is reported.
 */
export async function testApplicationToken(): Promise<void> {
  await requireAdmin();

  let outcome: Outcome;
  try {
    const tokens = await createApplicationOAuthClient().getApplicationToken();
    const seconds = Math.round((tokens.accessTokenExpiresAt.getTime() - Date.now()) / 1000);
    outcome = { tested: 'ok', expires: String(seconds) };
  } catch (error) {
    outcome = { tested: 'fail', detail: messageOf(error) };
  }

  go(outcome);
}

/**
 * Begin the consent round-trip.
 *
 * The state is generated here and kept in an httpOnly cookie rather than in the
 * database: it is single-use, short-lived, and tying it to the browser that
 * started the flow is precisely the property that makes it useful.
 */
export async function startEbayConnection(): Promise<void> {
  await requireAdmin();

  const state = createOAuthState();

  let authorizationUrl: string;
  try {
    authorizationUrl = createUserOAuthClient().buildAuthorizationUrl(state);
  } catch (error) {
    go({ error: 'config', detail: messageOf(error) });
  }

  // Only set once the URL is known good, so a misconfigured attempt does not
  // leave a stale state cookie behind.
  const jar = await cookies();
  jar.set(OAUTH_STATE_COOKIE, state, stateCookieOptions());

  redirect(authorizationUrl);
}

/**
 * Finish the round-trip from a pasted code.
 *
 * eBay frequently refuses to register an `http://localhost` redirect URL, which
 * leaves the admin looking at a consent screen that lands somewhere unreachable.
 * Rather than pretend that does not happen, this accepts whatever they copied
 * out of the address bar.
 *
 * There is no state to verify on this path — the admin performed the copy by
 * hand, so the browser round-trip that state protects never happened. That is
 * an acceptable trade only because the operator is an authenticated admin
 * deliberately pasting a value they just obtained, and the code is single-use
 * and expires in minutes.
 */
export async function completeEbayConnectionManually(formData: FormData): Promise<void> {
  await requireAdmin();

  const pasted = formData.get('pastedCode');
  const code = typeof pasted === 'string' ? extractAuthorizationCode(pasted) : null;

  if (!code) {
    go({
      error: 'paste',
      detail: 'コードを読み取れませんでした。リダイレクト先のURL全体を貼り付けてください。',
    });
  }

  const config = readEbayConfig();

  let outcome: Outcome;
  try {
    const tokens: TokenSet = await createUserOAuthClient().exchangeCode(code);

    const absent = missingScopes(tokens.scopes, REQUIRED_SCOPES);
    if (absent.length > 0) {
      // The token is real but useless for listing. Storing it would produce a
      // screen that says "connected" and a publish that fails with 403.
      outcome = { error: 'scopes', detail: absent.join(' ') };
    } else {
      await saveCredentials(config.environment, toStoredCredentials(tokens));
      outcome = { connected: '1' };
    }
  } catch (error) {
    outcome = { error: 'exchange', detail: messageOf(error) };
  }

  go(outcome);
}
