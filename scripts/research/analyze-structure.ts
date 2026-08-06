#!/usr/bin/env tsx
/**
 * Work out a page's structure from a saved snapshot, and propose selectors.
 *
 * Why this is a program rather than a person squinting at DevTools: the same
 * analysis has to be re-run every time a partner changes their markup, and a
 * written-down procedure that produces a diffable report is the difference
 * between "the adapter broke, someone go and look" and "the adapter broke,
 * here is what changed".
 *
 * It answers the questions that decide the whole fetching strategy:
 *   - is there JSON-LD or microdata? (structured data beats any selector)
 *   - does the no-JS HTML already contain products? (if yes, no Playwright)
 *   - what repeating element holds each product?
 *   - how does pagination work?
 *   - what stock vocabulary does the shop use?
 *
 * Usage: pnpm research:analyze docs/research/magi/product-group-14-ab12cd34.html
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import * as cheerio from 'cheerio';

interface Finding {
  question: string;
  answer: string;
  detail?: string[];
  /** What this implies for the adapter. */
  implication?: string;
}

/** Yen prices, in the shapes Japanese storefronts actually use. */
const PRICE_PATTERN = /(?:¥|￥|税込|税抜)?\s*([0-9][0-9,]{2,})\s*(?:円|yen)?/i;
const STOCK_VOCABULARY = [
  '在庫あり',
  '在庫切れ',
  '売り切れ',
  '完売',
  'SOLD OUT',
  'SOLDOUT',
  '残り',
  'カートに入れる',
  '購入',
  '入荷',
  '予約',
];

function analyzeStructuredData($: cheerio.CheerioAPI): Finding[] {
  const findings: Finding[] = [];

  const jsonLdBlocks: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      jsonLdBlocks.push(JSON.parse(raw));
    } catch {
      jsonLdBlocks.push({ __parseError: raw.slice(0, 200) });
    }
  });

  const types = jsonLdBlocks
    .flatMap((block) => (Array.isArray(block) ? block : [block]))
    .map((b) => (b as Record<string, unknown>)?.['@type'])
    .filter(Boolean)
    .map(String);

  findings.push({
    question: 'Is there JSON-LD structured data?',
    answer: jsonLdBlocks.length > 0 ? `yes — ${jsonLdBlocks.length} block(s)` : 'no',
    detail: types.length > 0 ? [`@type values: ${[...new Set(types)].join(', ')}`] : undefined,
    implication: types.some((t) => /Product|ItemList/i.test(t))
      ? 'Prefer JSON-LD over CSS selectors: it survives redesigns and carries provenance "structured_data" (highest automated trust).'
      : 'No product-level JSON-LD; selectors will be the primary extraction path.',
  });

  const microdata = $('[itemtype*="schema.org/Product"]').length;
  const ogTags = $('meta[property^="og:"]').length;
  findings.push({
    question: 'Microdata / OGP present?',
    answer: `microdata Product elements: ${microdata}, OGP meta tags: ${ogTags}`,
    implication:
      microdata > 0
        ? 'Microdata can supplement JSON-LD for per-product attributes.'
        : 'OGP alone only describes the page, not individual products.',
  });

  return findings;
}

function analyzeJsDependency($: cheerio.CheerioAPI, html: string): Finding[] {
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const hasPriceInHtml = PRICE_PATTERN.test(bodyText);
  const rootDivs = $('#root, #app, [data-reactroot], [data-server-rendered]').length;
  const scriptBytes = $('script')
    .toArray()
    .reduce((sum, el) => sum + $(el).contents().text().length, 0);
  const nextData = html.includes('__NEXT_DATA__');
  const nuxtData = html.includes('__NUXT__');

  const looksClientRendered = bodyText.length < 500 && rootDivs > 0;

  return [
    {
      question: 'Does the server-rendered HTML already contain the products?',
      answer: looksClientRendered
        ? 'NO — the body is nearly empty, this looks client-rendered'
        : `yes — ${bodyText.length} chars of body text, prices ${hasPriceInHtml ? 'present' : 'NOT found'}`,
      detail: [
        `script payload: ${scriptBytes} chars`,
        `SPA root elements: ${rootDivs}`,
        `__NEXT_DATA__: ${nextData}, __NUXT__: ${nuxtData}`,
      ],
      implication: looksClientRendered
        ? 'Playwright is required for this page. Restrict it to the pages that actually need it.'
        : 'Use undici + cheerio. Do NOT add Playwright — it is heavier, slower and more likely to be blocked, and this page does not need it.',
    },
  ];
}

/**
 * CSS.escape is a browser API and is not available in Node, so escape the
 * characters that are actually legal in a class attribute but special in a
 * selector. Tailwind-style names (`w-1/2`, `text-[#fff]`) hit this constantly.
 */
function escapeClassName(cls: string): string {
  // Escape the ASCII punctuation that is special in a selector.
  // Alphanumerics, hyphen, underscore and non-ASCII (Japanese class names
  // do occur) are left alone.
  return cls.replace(/(["#$%&'()*+,./:;<=>?@[\]^`{|}~!])/g, '\\$1');
}

/**
 * Find the repeating element that holds one product.
 *
 * Heuristic: a product card is a class that occurs many times, whose instances
 * each contain a link and something that parses as a price. Ranking by
 * (count x has-price x has-link) reliably surfaces the product grid ahead of
 * navigation menus and footers, which repeat but carry no prices.
 */
function analyzeProductCards($: cheerio.CheerioAPI): Finding[] {
  const classCounts = new Map<string, number>();
  $('[class]').each((_, el) => {
    const classes = ($(el).attr('class') ?? '').split(/\s+/).filter(Boolean);
    for (const cls of classes) {
      classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
    }
  });

  const candidates = [...classCounts.entries()]
    .filter(([, count]) => count >= 4 && count <= 200)
    .map(([cls, count]) => {
      const elements = $(`.${escapeClassName(cls)}`);
      let withPrice = 0;
      let withLink = 0;
      let withImage = 0;
      elements.each((_, el) => {
        const text = $(el).text();
        if (PRICE_PATTERN.test(text)) withPrice += 1;
        if ($(el).find('a[href]').length > 0) withLink += 1;
        if ($(el).find('img').length > 0) withImage += 1;
      });
      const score = (withPrice / count) * (withLink / count) * Math.min(count / 10, 1);
      return { cls, count, withPrice, withLink, withImage, score };
    })
    .filter((c) => c.withPrice > 0 && c.withLink > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  return [
    {
      question: 'Which repeating element is a product card?',
      answer:
        candidates.length > 0
          ? `best candidate: .${candidates[0]!.cls} (${candidates[0]!.count} instances)`
          : 'no repeating element containing both a price and a link was found',
      detail: candidates.map(
        (c) =>
          `.${c.cls} — ${c.count} instances, ${c.withPrice} with a price, ${c.withLink} with a link, ${c.withImage} with an image (score ${c.score.toFixed(3)})`,
      ),
      implication:
        candidates.length > 0
          ? `Start from list.productCard = ".${candidates[0]!.cls}" and verify the instance count matches the products visible on the page.`
          : 'If this page is client-rendered, re-snapshot with Playwright before drawing conclusions.',
    },
  ];
}

function analyzePagination($: cheerio.CheerioAPI, pageUrl: string): Finding[] {
  const paginationLinks = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const text = $(el).text().trim();
    if (/[?&](page|p|pageno|offset)=/i.test(href) || /\/page\/\d+/i.test(href)) {
      paginationLinks.add(`${text || '(no text)'} -> ${href}`);
    } else if (/^(次|次へ|next|›|»|\d+)$/i.test(text) && href !== '#') {
      paginationLinks.add(`${text} -> ${href}`);
    }
  });

  const samples = [...paginationLinks].slice(0, 12);
  const queryStyle = samples.some((s) => /[?&](page|p|pageno)=/i.test(s));
  const pathStyle = samples.some((s) => /\/page\/\d+/i.test(s));

  return [
    {
      question: 'How does pagination work?',
      answer: queryStyle
        ? 'query parameter (?page=N)'
        : pathStyle
          ? 'path segment (/page/N)'
          : samples.length > 0
            ? 'links found, style unclear'
            : 'no pagination links found — single page, or infinite scroll',
      detail: samples,
      implication: queryStyle
        ? 'pagination: { type: "query", param: "page" }. Remember the canonical URL must NOT include the page parameter.'
        : pathStyle
          ? 'pagination: { type: "path", template: "…/page/{n}" }.'
          : 'If the shop uses infinite scroll, look for the XHR endpoint it calls — that is usually cheaper and more stable than rendering.',
    },
    {
      question: 'Is there a rel=canonical?',
      answer: $('link[rel="canonical"]').attr('href') ?? 'none',
      implication:
        'A declared canonical URL should win over our own normalisation — the shop is telling us its stable identifier.',
    },
    { question: 'Page analysed', answer: pageUrl },
  ];
}

function analyzeStockVocabulary($: cheerio.CheerioAPI): Finding[] {
  const bodyText = $('body').text();
  const found = STOCK_VOCABULARY.filter((word) => bodyText.includes(word));

  const quantityMatches = [
    ...bodyText.matchAll(/残り\s*(\d+)\s*[点個]|在庫\s*[:：]?\s*(\d+)/g),
  ].slice(0, 10);

  return [
    {
      question: 'What stock vocabulary does this shop use?',
      answer: found.length > 0 ? found.join(', ') : 'none of the expected phrases were found',
      detail: quantityMatches.map((m) => `explicit quantity: "${m[0]}"`),
      implication:
        quantityMatches.length > 0
          ? 'The shop publishes exact counts — set capabilities.hasExactStockCount = true, and add a stockRule with a qtyGroup.'
          : 'Only in/out of stock is visible. Set hasExactStockCount = false, which forces eBay quantity to 1. Do not infer a count.',
    },
  ];
}

function analyzeProductLinks($: cheerio.CheerioAPI): Finding[] {
  const hrefs = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (/\/(product|detail|item|goods|shopdetail)[/?]/i.test(href)) hrefs.add(href);
  });

  const samples = [...hrefs].slice(0, 10);
  const idPatterns = samples
    .map((h) => {
      const numeric = /\/(\d{3,})(?:[/?]|$)/.exec(h);
      return numeric ? `numeric id in path: ${numeric[1]}` : null;
    })
    .filter(Boolean) as string[];

  return [
    {
      question: 'What do product detail URLs look like?',
      answer:
        samples.length > 0 ? `${hrefs.size} distinct product links` : 'no product links found',
      detail: samples,
      implication:
        idPatterns.length > 0
          ? 'A numeric ID appears in the path — productId: [{ from: "url_path", regex: "/(?:product|detail)/(\\\\d+)" }]. Confirm it is the shop\'s own ID and not a positional index.'
          : 'No obvious ID in the URL. Look for a data-* attribute or a JSON-LD sku before falling back to anything derived from the title — titles change, and a changed title must not orphan price history.',
    },
  ];
}

function renderReport(source: string, findings: Finding[]): string {
  const lines: string[] = [
    `# Structure report: ${basename(source)}`,
    '',
    `Generated ${new Date().toISOString()} from a saved snapshot (no network access).`,
    '',
    '> These are machine-generated hypotheses, not confirmed selectors. Verify each',
    '> one against the snapshot before writing it into supplier_settings.',
    '',
  ];

  for (const f of findings) {
    lines.push(`## ${f.question}`, '', `**${f.answer}**`, '');
    if (f.detail?.length) {
      lines.push('```');
      lines.push(...f.detail);
      lines.push('```', '');
    }
    if (f.implication) {
      lines.push(`→ ${f.implication}`, '');
    }
  }
  return lines.join('\n');
}

async function analyzeFile(path: string): Promise<void> {
  const html = await readFile(path, 'utf8');
  const $ = cheerio.load(html);

  let pageUrl = path;
  try {
    const meta = JSON.parse(await readFile(path.replace(/\.html$/, '.meta.json'), 'utf8'));
    pageUrl = meta.url ?? path;
  } catch {
    // Meta file is optional.
  }

  const findings = [
    ...analyzeJsDependency($, html),
    ...analyzeStructuredData($),
    ...analyzeProductCards($),
    ...analyzeProductLinks($),
    ...analyzeStockVocabulary($),
    ...analyzePagination($, pageUrl),
  ];

  const report = renderReport(path, findings);
  const outPath = join(dirname(path), `${basename(path, '.html')}.report.md`);
  await writeFile(outPath, report, 'utf8');

  console.log(report);
  console.log(`\nreport written to ${outPath}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));

  let files = args;
  if (files.length === 0) {
    // Default: analyse everything already snapshotted.
    const root = new URL('../../docs/research', import.meta.url).pathname;
    try {
      const suppliers = await readdir(root, { withFileTypes: true });
      files = (
        await Promise.all(
          suppliers
            .filter((d) => d.isDirectory())
            .map(async (d) =>
              (await readdir(join(root, d.name)))
                .filter((f) => f.endsWith('.html'))
                .map((f) => join(root, d.name, f)),
            ),
        )
      ).flat();
    } catch {
      files = [];
    }
  }

  if (files.length === 0) {
    console.error('No snapshots found. Run `pnpm research:snapshot --all` first.');
    console.error('(That requires network access to the partner sites.)');
    process.exit(1);
  }

  for (const file of files) {
    await analyzeFile(file);
  }
}

await main();
