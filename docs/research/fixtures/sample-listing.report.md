# Structure report: sample-listing.html

Generated 2026-08-06T05:06:54.440Z from a saved snapshot (no network access).

> These are machine-generated hypotheses, not confirmed selectors. Verify each
> one against the snapshot before writing it into supplier_settings.

## Does the server-rendered HTML already contain the products?

**yes — 269 chars of body text, prices present**

```
script payload: 359 chars
SPA root elements: 0
__NEXT_DATA__: false, __NUXT__: false
```

→ Use undici + cheerio. Do NOT add Playwright — it is heavier, slower and more likely to be blocked, and this page does not need it.

## Is there JSON-LD structured data?

**yes — 1 block(s)**

```
@type values: ItemList
```

→ Prefer JSON-LD over CSS selectors: it survives redesigns and carries provenance "structured_data" (highest automated trust).

## Microdata / OGP present?

**microdata Product elements: 0, OGP meta tags: 1**

→ OGP alone only describes the page, not individual products.

## Which repeating element is a product card?

**best candidate: .product-item (5 instances)**

```
.product-item — 5 instances, 5 with a price, 5 with a link, 5 with an image (score 0.500)
```

→ Start from list.productCard = ".product-item" and verify the instance count matches the products visible on the page.

## What do product detail URLs look like?

**5 distinct product links**

```
/product/100234
/product/100235
/product/100236
/product/100237
/product/100238
```

→ A numeric ID appears in the path — productId: [{ from: "url_path", regex: "/(?:product|detail)/(\\d+)" }]. Confirm it is the shop's own ID and not a positional index.

## What stock vocabulary does this shop use?

**在庫あり, SOLD OUT, 残り, カートに入れる**

```
explicit quantity: "残り 2 点"
explicit quantity: "残り 1 点"
```

→ The shop publishes exact counts — set capabilities.hasExactStockCount = true, and add a stockRule with a qtyGroup.

## How does pagination work?

**query parameter (?page=N)**

```
1 -> /product-group/99?page=1
2 -> /product-group/99?page=2
3 -> /product-group/99?page=3
次へ -> /product-group/99?page=2
```

→ pagination: { type: "query", param: "page" }. Remember the canonical URL must NOT include the page parameter.

## Is there a rel=canonical?

**https://example.test/product-group/99**

→ A declared canonical URL should win over our own normalisation — the shop is telling us its stable identifier.

## Page analysed

**docs/research/fixtures/sample-listing.html**
