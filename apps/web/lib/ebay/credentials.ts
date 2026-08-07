import 'server-only';
import { and, eq } from 'drizzle-orm';
import { ebayCredentials, getDb } from '@cardbridge/db';
import {
  isAccessTokenUsable,
  isRefreshTokenExpired,
  type EbayEnvironment,
  type StoredCredentials,
} from '@cardbridge/ebay';
import { ebayAccountKey } from './config';

/**
 * Persistence for the seller's OAuth tokens.
 *
 * Only the encrypted forms ever cross this boundary. Nothing here decrypts, so
 * a caller that just wants to render connection status cannot accidentally pull
 * a live refresh token into a React tree.
 */

export interface ConnectionStatus {
  connected: boolean;
  environment: EbayEnvironment;
  scopes: string[];
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  updatedAt: Date | null;
  /** True when the refresh token is dead and an admin must consent again. */
  needsReauthorization: boolean;
  accessTokenUsable: boolean;
}

export async function loadCredentials(
  environment: EbayEnvironment,
): Promise<StoredCredentials | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(ebayCredentials)
    .where(
      and(
        eq(ebayCredentials.account, ebayAccountKey()),
        eq(ebayCredentials.environment, environment),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    refreshTokenEnc: row.refreshTokenEnc,
    accessTokenEnc: row.accessTokenEnc,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    refreshTokenExpiresAt: row.refreshTokenExpiresAt,
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
  };
}

export async function saveCredentials(
  environment: EbayEnvironment,
  credentials: StoredCredentials,
): Promise<void> {
  const db = getDb();
  await db
    .insert(ebayCredentials)
    .values({
      account: ebayAccountKey(),
      environment,
      refreshTokenEnc: credentials.refreshTokenEnc,
      accessTokenEnc: credentials.accessTokenEnc,
      accessTokenExpiresAt: credentials.accessTokenExpiresAt,
      refreshTokenExpiresAt: credentials.refreshTokenExpiresAt,
      scopes: credentials.scopes,
      updatedAt: new Date(),
    })
    // Re-consenting must replace the old tokens rather than fail on the unique
    // constraint, and rather than leave two rows where a reader picks one.
    .onConflictDoUpdate({
      target: [ebayCredentials.account, ebayCredentials.environment],
      set: {
        refreshTokenEnc: credentials.refreshTokenEnc,
        accessTokenEnc: credentials.accessTokenEnc,
        accessTokenExpiresAt: credentials.accessTokenExpiresAt,
        refreshTokenExpiresAt: credentials.refreshTokenExpiresAt,
        scopes: credentials.scopes,
        updatedAt: new Date(),
      },
    });
}

export async function getConnectionStatus(environment: EbayEnvironment): Promise<ConnectionStatus> {
  let credentials: StoredCredentials | null = null;
  try {
    credentials = await loadCredentials(environment);
  } catch {
    // No database configured yet. "Not connected" is the honest answer, and it
    // lets the setup screen render for someone who has not reached Supabase yet.
    return {
      connected: false,
      environment,
      scopes: [],
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      updatedAt: null,
      needsReauthorization: false,
      accessTokenUsable: false,
    };
  }

  if (!credentials) {
    return {
      connected: false,
      environment,
      scopes: [],
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      updatedAt: null,
      needsReauthorization: false,
      accessTokenUsable: false,
    };
  }

  return {
    connected: true,
    environment,
    scopes: credentials.scopes,
    accessTokenExpiresAt: credentials.accessTokenExpiresAt,
    refreshTokenExpiresAt: credentials.refreshTokenExpiresAt,
    updatedAt: null,
    needsReauthorization: isRefreshTokenExpired(credentials),
    accessTokenUsable: isAccessTokenUsable(credentials),
  };
}
