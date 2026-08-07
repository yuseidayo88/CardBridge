import 'server-only';
import { EbayOAuthClient, type EbayEnvironment } from '@cardbridge/ebay';

/**
 * eBay credentials from the environment.
 *
 * Missing configuration is reported as data, not thrown. The connection screen
 * has to render *because* something is missing — a page that crashes when the
 * keys are absent is a page nobody can use to find out which key is absent.
 */

export interface EbayConfigStatus {
  environment: EbayEnvironment;
  appId: string | null;
  hasCertId: boolean;
  redirectUri: string | null;
  hasEncryptionKey: boolean;
  /** Human-readable names of what is still missing. */
  missing: string[];
}

function readEnvironment(): EbayEnvironment {
  // Anything other than the exact string PRODUCTION means sandbox. Defaulting
  // in the other direction would make a typo point at the live account.
  return process.env.EBAY_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';
}

export function readEbayConfig(): EbayConfigStatus {
  const appId = process.env.EBAY_APP_ID || null;
  const certId = process.env.EBAY_CERT_ID || null;
  const redirectUri = process.env.EBAY_REDIRECT_URI || null;
  const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY || null;

  const missing: string[] = [];
  if (!appId) missing.push('EBAY_APP_ID');
  if (!certId) missing.push('EBAY_CERT_ID');
  if (!encryptionKey) missing.push('TOKEN_ENCRYPTION_KEY');
  // EBAY_REDIRECT_URI is intentionally absent from this list: the application
  // token flow does not need it, so metadata work can proceed before a RuName
  // exists. The user-consent flow checks for it separately.

  return {
    environment: readEnvironment(),
    appId,
    hasCertId: Boolean(certId),
    redirectUri,
    hasEncryptionKey: Boolean(encryptionKey),
    missing,
  };
}

export class EbayNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(`eBay is not configured. Missing: ${missing.join(', ')}`);
    this.name = 'EbayNotConfiguredError';
  }
}

/**
 * A client for the application-token flow (Metadata API).
 *
 * No RuName required, so this works the moment App ID and Cert ID exist.
 */
export function createApplicationOAuthClient(): EbayOAuthClient {
  const config = readEbayConfig();
  if (!config.appId || !config.hasCertId) {
    throw new EbayNotConfiguredError(config.missing);
  }
  return new EbayOAuthClient({
    environment: config.environment,
    appId: config.appId,
    certId: process.env.EBAY_CERT_ID!,
    // Unused by client_credentials, but the constructor wants a value and an
    // empty string would be a confusing thing to find in an error message.
    redirectUri: config.redirectUri ?? 'unset',
  });
}

/** A client for the user-consent flow. Needs the RuName. */
export function createUserOAuthClient(): EbayOAuthClient {
  const config = readEbayConfig();
  const missing = [...config.missing];
  if (!config.redirectUri) missing.push('EBAY_REDIRECT_URI');
  if (missing.length > 0) throw new EbayNotConfiguredError(missing);

  return new EbayOAuthClient({
    environment: config.environment,
    appId: config.appId!,
    certId: process.env.EBAY_CERT_ID!,
    redirectUri: config.redirectUri!,
  });
}

/** The row key under which this deployment's tokens are stored. */
export function ebayAccountKey(): string {
  return process.env.EBAY_ACCOUNT ?? 'default';
}
