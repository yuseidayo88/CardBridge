/**
 * URL validation and normalisation.
 *
 * Two jobs, both load-bearing:
 *
 * 1. SSRF defence. Image URLs arrive from scraped HTML — that is, from a
 *    third party's markup. If a shop's page is ever compromised, an <img src>
 *    pointing at http://169.254.169.254/latest/meta-data/ turns our image
 *    fetcher into a credential exfiltration tool. So the fetcher only ever
 *    talks to hosts on an explicit allowlist, and only over HTTPS.
 *
 * 2. Canonical URLs. A product URL with ?sort=new&utm_source=x is not a
 *    durable identifier: it changes with navigation and pollutes both the
 *    database and the shop's analytics. Everything is normalised to the
 *    stable form before storage.
 */

/** Query parameters that are never part of a product's identity. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^gclid$/i,
  /^fbclid$/i,
  /^yclid$/i,
  /^msclkid$/i,
  /^_ga$/i,
  /^ref$/i,
  /^referrer$/i,
  /^from$/i,
  /^sort$/i,
  /^order$/i,
  /^view$/i,
  /^display$/i,
  /^limit$/i,
  /^per_page$/i,
  /^page$/i, // pagination is a fetch parameter, not part of the canonical URL
  /^session/i,
  /^sid$/i,
];

export class UnsafeUrlError extends Error {
  constructor(
    readonly url: string,
    reason: string,
  ) {
    super(`Refusing to fetch ${url}: ${reason}`);
    this.name = 'UnsafeUrlError';
  }
}

/**
 * IPv4/IPv6 literals that must never be fetched. Checked against the literal
 * host only — DNS rebinding is not defended against here, which is why the
 * allowlist below is the primary control rather than this list.
 */
function isPrivateHostLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (
    host === '::1' ||
    host === '::' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    return true;
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;

  const octets = v4.slice(1, 5).map(Number);
  const [a, b] = octets as [number, number, number, number];
  if (octets.some((o) => o > 255)) return true; // malformed: reject

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // cloud metadata endpoints
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

export interface UrlSafetyOptions {
  /** Hosts we are permitted to contact. Suffix-matched on the registered domain. */
  allowedHosts: readonly string[];
  /** Permit http:// as well as https://. Off by default. */
  allowInsecure?: boolean;
}

export function assertSafeUrl(rawUrl: string, options: UrlSafetyOptions): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError(rawUrl, 'not a parseable absolute URL');
  }

  const scheme = url.protocol.replace(':', '');
  if (scheme !== 'https' && !(options.allowInsecure && scheme === 'http')) {
    throw new UnsafeUrlError(rawUrl, `scheme "${scheme}" is not permitted`);
  }

  if (url.username || url.password) {
    throw new UnsafeUrlError(rawUrl, 'embedded credentials are not permitted');
  }

  if (isPrivateHostLiteral(url.hostname)) {
    throw new UnsafeUrlError(rawUrl, 'host resolves to a private or link-local address');
  }

  const host = url.hostname.toLowerCase();
  const allowed = options.allowedHosts.some(
    (candidate) => host === candidate.toLowerCase() || host.endsWith(`.${candidate.toLowerCase()}`),
  );
  if (!allowed) {
    throw new UnsafeUrlError(rawUrl, `host "${host}" is not in the allowlist`);
  }

  return url;
}

export interface NormalizeOptions {
  /** Extra params to keep — a shop may use a query param as the product ID. */
  keepParams?: readonly string[];
  /** Force this host, so www/non-www variants collapse to one row. */
  forceHost?: string;
  /** Keep the trailing slash rather than stripping it. */
  keepTrailingSlash?: boolean;
}

/**
 * Reduce a URL to the form that identifies the resource and nothing else.
 *
 * The result is what gets stored as canonical_url and what product identity is
 * keyed on, so it must be stable across navigation paths: the same product
 * reached from a category page, a search result and a shared link has to
 * produce one string.
 */
export function normalizeUrl(rawUrl: string, options: NormalizeOptions = {}): string {
  const url = new URL(rawUrl);

  url.protocol = 'https:';
  if (options.forceHost) {
    url.hostname = options.forceHost;
  }
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  url.port = '';

  const keep = new Set((options.keepParams ?? []).map((p) => p.toLowerCase()));
  const params = new URLSearchParams(url.search);
  for (const key of [...params.keys()]) {
    if (keep.has(key.toLowerCase())) continue;
    if (TRACKING_PARAMS.some((pattern) => pattern.test(key))) {
      params.delete(key);
    }
  }
  // Sort what survives, so parameter order cannot create two identities for
  // one product.
  const sorted = new URLSearchParams([...params.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const queryString = sorted.toString();
  url.search = queryString ? `?${queryString}` : '';

  if (!options.keepTrailingSlash && url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');

  return url.toString();
}
