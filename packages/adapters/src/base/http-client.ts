import { createHash } from 'node:crypto';
import { RateLimiter, backoffDelayMs, sleep } from './rate-limiter';
import { assertSafeUrl, type UrlSafetyOptions } from './url-safety';

/**
 * The only way this system makes an outbound request to a partner shop.
 *
 * Everything the courtesy policy promises is enforced here rather than left to
 * each adapter: pacing, conditional GET, a bounded retry budget, an honest
 * User-Agent with a contact address, and a hard allowlist of hosts.
 *
 * Conditional GET matters more than it looks. A full sync re-reads the same
 * category pages every few hours; with If-None-Match, an unchanged page costs
 * the shop a 304 and a few bytes instead of rendering and shipping the whole
 * document. Across two shops and years of operation, that is the difference
 * between a considerate integration and a standing load.
 */

export interface HttpClientOptions {
  userAgent: string;
  allowedHosts: readonly string[];
  minIntervalMs?: number;
  jitterMs?: number;
  maxConcurrency?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Bound on response size, so a bad URL cannot exhaust memory. */
  maxResponseBytes?: number;
  allowInsecure?: boolean;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ConditionalHeaders {
  etag?: string | null;
  lastModified?: string | null;
}

export interface HttpResponse {
  url: string;
  status: number;
  /** True when the server confirmed nothing changed; `body` is then empty. */
  notModified: boolean;
  body: string;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  /** SHA-256 of the body, for change detection independent of ETag support. */
  contentHash: string;
  fetchedAt: string;
  attempts: number;
}

export interface BinaryResponse {
  url: string;
  status: number;
  bytes: Buffer;
  contentType: string | null;
  contentHash: string;
  fetchedAt: string;
}

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly attempts: number,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} for ${url} after ${attempts} attempt(s)`);
    this.name = 'HttpError';
  }
}

/** 5xx and 429 are worth retrying; 4xx means we asked for the wrong thing. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export class HttpClient {
  private readonly limiter: RateLimiter;
  private readonly safety: UrlSafetyOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpClientOptions) {
    this.limiter = new RateLimiter({
      minIntervalMs: options.minIntervalMs ?? 3000,
      jitterMs: options.jitterMs ?? 1000,
      maxConcurrency: options.maxConcurrency ?? 1,
    });
    this.safety = {
      allowedHosts: options.allowedHosts,
      allowInsecure: options.allowInsecure ?? false,
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Fetch a document, honouring conditional-GET tokens from the last visit.
   *
   * A 304 returns immediately with `notModified: true` and no body — callers
   * treat that as "nothing to do" and skip parsing entirely.
   */
  async getText(url: string, conditional: ConditionalHeaders = {}): Promise<HttpResponse> {
    const safeUrl = assertSafeUrl(url, this.safety);
    const maxAttempts = this.options.maxAttempts ?? 3;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await this.limiter.schedule(safeUrl.hostname, () =>
          this.rawFetch(safeUrl, conditional),
        );

        if (response.status === 304) {
          return {
            url: safeUrl.toString(),
            status: 304,
            notModified: true,
            body: '',
            etag: conditional.etag ?? null,
            lastModified: conditional.lastModified ?? null,
            contentType: response.headers.get('content-type'),
            contentHash: '',
            fetchedAt: new Date().toISOString(),
            attempts: attempt,
          };
        }

        if (!response.ok) {
          if (isRetryableStatus(response.status) && attempt < maxAttempts) {
            await sleep(this.retryDelayMs(response, attempt));
            continue;
          }
          throw new HttpError(safeUrl.toString(), response.status, attempt);
        }

        const body = await this.readTextBounded(response);
        return {
          url: safeUrl.toString(),
          status: response.status,
          notModified: false,
          body,
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
          contentType: response.headers.get('content-type'),
          contentHash: sha256(body),
          fetchedAt: new Date().toISOString(),
          attempts: attempt,
        };
      } catch (error) {
        lastError = error;
        // A definite HTTP answer is not a transport failure — do not retry it.
        if (error instanceof HttpError) throw error;
        if (attempt >= maxAttempts) break;
        await sleep(backoffDelayMs(attempt));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Request to ${url} failed after ${maxAttempts} attempts`);
  }

  /** Fetch binary content (images), with the same safety and pacing rules. */
  async getBinary(url: string): Promise<BinaryResponse> {
    const safeUrl = assertSafeUrl(url, this.safety);
    const response = await this.limiter.schedule(safeUrl.hostname, () =>
      this.rawFetch(safeUrl, {}),
    );
    if (!response.ok) {
      throw new HttpError(safeUrl.toString(), response.status, 1);
    }

    const maxBytes = this.options.maxResponseBytes ?? 20 * 1024 * 1024;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Response from ${url} exceeds the ${maxBytes} byte limit`);
    }

    return {
      url: safeUrl.toString(),
      status: response.status,
      bytes: buffer,
      contentType: response.headers.get('content-type'),
      contentHash: sha256(buffer),
      fetchedAt: new Date().toISOString(),
    };
  }

  private async rawFetch(url: URL, conditional: ConditionalHeaders): Promise<Response> {
    const headers: Record<string, string> = {
      'User-Agent': this.options.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/*;q=0.8,*/*;q=0.5',
      'Accept-Language': 'ja,en;q=0.8',
    };
    if (conditional.etag) headers['If-None-Match'] = conditional.etag;
    if (conditional.lastModified) headers['If-Modified-Since'] = conditional.lastModified;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      return await this.fetchImpl(url.toString(), {
        headers,
        signal: controller.signal,
        // Redirects are followed manually so each hop is re-validated against
        // the allowlist — otherwise an open redirect on a partner's domain
        // would be a way out of it.
        redirect: 'manual',
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Respect Retry-After when the server sends one; back off otherwise. */
  private retryDelayMs(response: Response, attempt: number): number {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, 120_000);
      }
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date)) {
        return Math.min(Math.max(0, date - Date.now()), 120_000);
      }
    }
    return backoffDelayMs(attempt);
  }

  private async readTextBounded(response: Response): Promise<string> {
    const maxBytes = this.options.maxResponseBytes ?? 20 * 1024 * 1024;
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > maxBytes) {
      throw new Error(`Response exceeds the ${maxBytes} byte limit`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`Response exceeds the ${maxBytes} byte limit`);
    }
    return text;
  }
}
