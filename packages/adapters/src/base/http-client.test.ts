import { describe, expect, it, vi } from 'vitest';
import { HttpClient, HttpError } from './http-client';
import { UnsafeUrlError, assertSafeUrl, normalizeUrl } from './url-safety';

const ALLOWED = ['magicardshop.jp', 'cardrush-pokemon.jp'];

const okResponse = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } });

const client = (fetchImpl: typeof fetch) =>
  new HttpClient({
    userAgent: 'CardBridgeBot/1.0 (+https://example.com/contact)',
    allowedHosts: ALLOWED,
    minIntervalMs: 0,
    jitterMs: 0,
    fetchImpl,
  });

describe('URL safety — SSRF defence', () => {
  it('rejects cloud metadata endpoints', () => {
    expect(() =>
      assertSafeUrl('http://169.254.169.254/latest/meta-data/', {
        allowedHosts: ['169.254.169.254'],
        allowInsecure: true,
      }),
    ).toThrow(UnsafeUrlError);
  });

  it('rejects private and loopback ranges even if allowlisted', () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', 'localhost']) {
      expect(() =>
        assertSafeUrl(`http://${host}/x`, { allowedHosts: [host], allowInsecure: true }),
      ).toThrow(UnsafeUrlError);
    }
  });

  it('rejects hosts outside the allowlist', () => {
    expect(() => assertSafeUrl('https://evil.example.com/x', { allowedHosts: ALLOWED })).toThrow(
      /not in the allowlist/,
    );
  });

  it('is not fooled by a lookalike suffix', () => {
    // "notmagicardshop.jp" must not match "magicardshop.jp".
    expect(() => assertSafeUrl('https://notmagicardshop.jp/x', { allowedHosts: ALLOWED })).toThrow(
      /not in the allowlist/,
    );
  });

  it('accepts subdomains of an allowlisted host', () => {
    expect(() =>
      assertSafeUrl('https://www.magicardshop.jp/product-group/14', { allowedHosts: ALLOWED }),
    ).not.toThrow();
  });

  it('rejects non-https by default', () => {
    expect(() => assertSafeUrl('http://www.magicardshop.jp/x', { allowedHosts: ALLOWED })).toThrow(
      /scheme/,
    );
  });

  it('rejects embedded credentials', () => {
    expect(() =>
      assertSafeUrl('https://user:pass@www.magicardshop.jp/x', { allowedHosts: ALLOWED }),
    ).toThrow(/credentials/);
  });

  it('rejects non-http schemes outright', () => {
    expect(() => assertSafeUrl('file:///etc/passwd', { allowedHosts: ALLOWED })).toThrow();
    expect(() => assertSafeUrl('gopher://x/', { allowedHosts: ALLOWED })).toThrow();
  });
});

describe('URL normalisation', () => {
  it('strips tracking and navigation parameters', () => {
    expect(
      normalizeUrl(
        'https://www.cardrush-pokemon.jp/product-group/277?sort=new&page=2&utm_source=x&fbclid=y',
      ),
    ).toBe('https://www.cardrush-pokemon.jp/product-group/277');
  });

  it('keeps parameters a shop uses as an identifier', () => {
    expect(
      normalizeUrl('https://www.magicardshop.jp/detail?pid=12345&utm_source=x', {
        keepParams: ['pid'],
      }),
    ).toBe('https://www.magicardshop.jp/detail?pid=12345');
  });

  it('collapses variants that name the same resource', () => {
    const variants = [
      'https://www.magicardshop.jp/product-group/14/',
      'https://WWW.magicardshop.jp/product-group/14#top',
      'https://www.magicardshop.jp/product-group//14',
      'http://www.magicardshop.jp/product-group/14?utm_medium=email',
    ];
    const normalized = variants.map((v) => normalizeUrl(v));
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe('https://www.magicardshop.jp/product-group/14');
  });

  it('sorts surviving parameters so order cannot fork identity', () => {
    const a = normalizeUrl('https://www.magicardshop.jp/d?b=2&a=1', { keepParams: ['a', 'b'] });
    const b = normalizeUrl('https://www.magicardshop.jp/d?a=1&b=2', { keepParams: ['a', 'b'] });
    expect(a).toBe(b);
  });
});

describe('HttpClient — conditional GET', () => {
  it('sends If-None-Match when an ETag is known', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('<html/>'));
    await client(fetchImpl as unknown as typeof fetch).getText(
      'https://www.magicardshop.jp/product-group/14',
      { etag: 'W/"abc"' },
    );

    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('W/"abc"');
  });

  it('returns notModified without a body on 304, so nothing gets re-parsed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const result = await client(fetchImpl as unknown as typeof fetch).getText(
      'https://www.magicardshop.jp/product-group/14',
      { etag: 'W/"abc"' },
    );

    expect(result.notModified).toBe(true);
    expect(result.body).toBe('');
    expect(result.etag).toBe('W/"abc"');
  });

  it('hashes the body so change detection works without ETag support', async () => {
    // A fresh Response per call: a body can only be consumed once.
    const fetchImpl = vi.fn().mockImplementation(async () => okResponse('<html>same</html>'));
    const c = client(fetchImpl as unknown as typeof fetch);
    const first = await c.getText('https://www.magicardshop.jp/a');
    const second = await c.getText('https://www.magicardshop.jp/b');
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.contentHash).toHaveLength(64);
  });

  it('identifies itself with a contactable User-Agent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('<html/>'));
    await client(fetchImpl as unknown as typeof fetch).getText('https://www.magicardshop.jp/x');

    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('CardBridgeBot');
    expect(headers['User-Agent']).toContain('http');
  });
});

describe('HttpClient — retry budget', () => {
  it('retries 5xx up to the cap, then gives up', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    const c = new HttpClient({
      userAgent: 'test',
      allowedHosts: ALLOWED,
      minIntervalMs: 0,
      jitterMs: 0,
      maxAttempts: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(c.getText('https://www.magicardshop.jp/x')).rejects.toThrow(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 404 — the URL is wrong, not the moment', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const c = client(fetchImpl as unknown as typeof fetch);

    await expect(c.getText('https://www.magicardshop.jp/gone')).rejects.toThrow(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After on 429 rather than backing off blindly', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(okResponse('<html/>'));
    const c = client(fetchImpl as unknown as typeof fetch);

    const result = await c.getText('https://www.magicardshop.jp/x');
    expect(result.status).toBe(200);
    expect(result.attempts).toBe(2);
  });

  it('never contacts a host outside the allowlist', async () => {
    const fetchImpl = vi.fn();
    const c = client(fetchImpl as unknown as typeof fetch);

    await expect(c.getText('https://evil.example.com/x')).rejects.toThrow(UnsafeUrlError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('HttpClient — pacing', () => {
  it('serialises requests to one host with a minimum gap', async () => {
    const timestamps: number[] = [];
    const fetchImpl = vi.fn().mockImplementation(async () => {
      timestamps.push(Date.now());
      return okResponse('<html/>');
    });
    const c = new HttpClient({
      userAgent: 'test',
      allowedHosts: ALLOWED,
      minIntervalMs: 60,
      jitterMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await Promise.all([
      c.getText('https://www.magicardshop.jp/1'),
      c.getText('https://www.magicardshop.jp/2'),
      c.getText('https://www.magicardshop.jp/3'),
    ]);

    expect(timestamps).toHaveLength(3);
    for (let i = 1; i < timestamps.length; i += 1) {
      // Allow a few ms of timer slack.
      expect(timestamps[i]! - timestamps[i - 1]!).toBeGreaterThanOrEqual(50);
    }
  });
});
