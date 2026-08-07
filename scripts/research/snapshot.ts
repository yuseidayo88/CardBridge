#!/usr/bin/env tsx
/**
 * Fetch a page once and store it for offline analysis.
 *
 * The point is that a partner's site gets hit exactly one time per URL during
 * selector development. Everything after that — trying selectors, arguing about
 * pagination, re-running the analyser after a bug fix — happens against the
 * saved copy. Iterating against the live site instead would mean dozens of
 * requests to work out something that one response already answers.
 *
 * Usage:
 *   pnpm research:snapshot https://www.magicardshop.jp/product-group/14
 *   pnpm research:snapshot --supplier magi --all      # every seeded category URL
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { HttpClient } from '../../packages/adapters/src/base/http-client';

/**
 * The listing URLs each shop actually uses, confirmed by the operator against
 * the live sites.
 *
 * Page ranges are hard-coded rather than crawled to exhaustion on purpose. This
 * is exploratory traffic on a partner's shop, and a loop that stops when it sees
 * an empty page will always make one wasted request — worse, a shop that serves
 * the first page for an out-of-range number would make it loop forever.
 */
const SUPPLIERS: Record<string, { hosts: string[]; urls: string[]; note?: string }> = {
  magi: {
    hosts: ['magicardshop.jp'],
    urls: pages('https://www.magicardshop.jp/product-group/14?page=', 1, 5),
  },
  cardrush: {
    hosts: ['cardrush-pokemon.jp'],
    // num=100 packs 100 products into one response, so 14 pages cover the
    // category in 14 requests instead of several hundred. available=1 filters
    // to purchasable stock, which is the only stock we can act on anyway.
    urls: [
      'https://www.cardrush-pokemon.jp/product-group/277/0/photo?num=100&img=160&available=1&sort=',
      ...pages(
        'https://www.cardrush-pokemon.jp/product-group/277/0/photo?num=100&img=160&available=1&sort=&page=',
        2,
        14,
      ),
    ],
    note: 'available=1 means these pages list only purchasable items; a product that disappears between runs is sold out rather than merely unseen.',
  },
};

function pages(base: string, from: number, to: number): string[] {
  const urls: string[] = [];
  for (let page = from; page <= to; page += 1) urls.push(`${base}${page}`);
  return urls;
}

const ROOT = new URL('../..', import.meta.url).pathname;
const OUT_DIR = join(ROOT, 'docs/research');

function supplierForUrl(url: string): string {
  const host = new URL(url).hostname;
  for (const [code, cfg] of Object.entries(SUPPLIERS)) {
    if (cfg.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return code;
  }
  return 'unknown';
}

async function snapshot(url: string): Promise<void> {
  const supplier = supplierForUrl(url);
  const hosts = SUPPLIERS[supplier]?.hosts ?? [new URL(url).hostname];

  const client = new HttpClient({
    userAgent: process.env.SCRAPER_USER_AGENT ?? 'CardBridgeBot/1.0 (+https://example.com/contact)',
    allowedHosts: hosts,
    // Generous pacing: this is exploratory traffic on someone else's shop.
    minIntervalMs: 5000,
    jitterMs: 2000,
    maxAttempts: 2,
  });

  console.log(`fetching ${url}`);
  const response = await client.getText(url);

  const slug = new URL(url).pathname.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 8);
  const base = join(OUT_DIR, supplier, `${slug || 'index'}-${hash}`);

  await mkdir(dirname(base), { recursive: true });
  await writeFile(`${base}.html`, response.body, 'utf8');
  await writeFile(
    `${base}.meta.json`,
    JSON.stringify(
      {
        url: response.url,
        supplier,
        status: response.status,
        contentType: response.contentType,
        // Recorded so the adapter can be told whether conditional GET is worth
        // attempting against this shop.
        etag: response.etag,
        lastModified: response.lastModified,
        contentHash: response.contentHash,
        bytes: Buffer.byteLength(response.body, 'utf8'),
        fetchedAt: response.fetchedAt,
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log(`  saved ${base}.html (${Buffer.byteLength(response.body, 'utf8')} bytes)`);
  console.log(`  etag=${response.etag ?? 'none'} last-modified=${response.lastModified ?? 'none'}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let urls: string[];
  if (args.includes('--all')) {
    const idx = args.indexOf('--supplier');
    const code = idx >= 0 ? args[idx + 1] : undefined;
    urls = code ? (SUPPLIERS[code]?.urls ?? []) : Object.values(SUPPLIERS).flatMap((s) => s.urls);
  } else {
    urls = args.filter((a) => a.startsWith('http'));
  }

  if (urls.length === 0) {
    console.error('Usage: pnpm research:snapshot <url...> | --all [--supplier <code>]');
    process.exit(1);
  }

  for (const url of urls) {
    try {
      await snapshot(url);
    } catch (error) {
      console.error(`  FAILED ${url}: ${(error as Error).message}`);
      // Keep going: one unreachable URL should not abandon the rest.
    }
  }
}

await main();
