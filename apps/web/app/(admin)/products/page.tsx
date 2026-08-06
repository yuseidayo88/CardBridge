import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { getDb } from '@cardbridge/db';
import { requireAdmin } from '@/lib/auth/require-admin';
import { VerdictBadge } from '@/components/verdict-badge';

export const dynamic = 'force-dynamic';

interface ProductRow extends Record<string, unknown> {
  id: string;
  raw_title: string;
  supplier_code: string;
  price_incl_tax_jpy: string;
  stock_qty: number | null;
  stock_status: string;
  psa_verdict: string;
  parse_confidence: string;
  image_count: string;
  catalog_product_id: string | null;
  listing_status: string | null;
}

/**
 * One row per supplier product, joined to whatever downstream state exists.
 *
 * Left joins throughout: a product that has not been matched, imaged or listed
 * yet is exactly the product an operator most needs to see, so it must not fall
 * out of the result.
 */
async function loadProducts(verdict?: string) {
  const db = getDb();
  const filter = verdict ? sql`WHERE sp.psa_verdict = ${verdict}::psa_verdict` : sql``;

  return db.execute<ProductRow>(sql`
    SELECT
      sp.id,
      sp.raw_title,
      s.code AS supplier_code,
      sp.price_incl_tax_jpy,
      sp.stock_qty,
      sp.stock_status::text AS stock_status,
      sp.psa_verdict::text AS psa_verdict,
      sp.parse_confidence,
      (SELECT count(*) FROM product_images pi WHERE pi.supplier_product_id = sp.id) AS image_count,
      pm.catalog_product_id,
      ml.status::text AS listing_status
    FROM supplier_products sp
    JOIN suppliers s ON s.id = sp.supplier_id
    LEFT JOIN product_matches pm
      ON pm.supplier_product_id = sp.id AND pm.unmatched_at IS NULL
    LEFT JOIN marketplace_listings ml
      ON ml.catalog_product_id = pm.catalog_product_id
    ${filter}
    ORDER BY sp.last_checked_at DESC
    LIMIT 200
  `);
}

const FILTERS = [
  { label: 'すべて', value: undefined },
  { label: 'PSA10 確定', value: 'CONFIRMED' },
  { label: '要確認', value: 'REVIEW' },
] as const;

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ verdict?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;

  let rows: ProductRow[] = [];
  let error: string | null = null;
  try {
    rows = [...(await loadProducts(params.verdict))];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">商品一覧</h1>
      <p className="mb-4 text-sm text-slate-500">
        提携先から取得した商品です。取得ジョブが動くまでは空が正常です。
      </p>

      <div className="mb-4 flex gap-2 text-sm">
        {FILTERS.map((filter) => (
          <Link
            key={filter.label}
            href={filter.value ? `/products?verdict=${filter.value}` : '/products'}
            className={`rounded border px-3 py-1 ${
              params.verdict === filter.value
                ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                : 'border-slate-300 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800'
            }`}
          >
            {filter.label}
          </Link>
        ))}
      </div>

      {error ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="font-medium">データベースに接続できません</div>
          <div className="mt-1 font-mono text-xs">{error}</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-600">
          商品がありません。仕入れ先のセレクター設定と同期ジョブをご確認ください。
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left dark:bg-slate-800">
              <tr>
                <th className="p-3 font-medium">商品名</th>
                <th className="p-3 font-medium">店舗</th>
                <th className="p-3 text-right font-medium">価格</th>
                <th className="p-3 font-medium">在庫</th>
                <th className="p-3 font-medium">PSA判定</th>
                <th className="p-3 text-right font-medium">解析信頼度</th>
                <th className="p-3 text-right font-medium">画像</th>
                <th className="p-3 font-medium">出品状態</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-t border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  <td className="max-w-md p-3">
                    <Link href={`/products/${row.id}`} className="hover:underline">
                      {row.raw_title}
                    </Link>
                  </td>
                  <td className="p-3 text-slate-500">{row.supplier_code}</td>
                  <td className="p-3 text-right tabular-nums">
                    ¥{Number(row.price_incl_tax_jpy).toLocaleString('ja-JP')}
                  </td>
                  <td className="p-3">
                    <StockCell status={row.stock_status} qty={row.stock_qty} />
                  </td>
                  <td className="p-3">
                    <VerdictBadge verdict={row.psa_verdict} />
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {Number(row.parse_confidence).toFixed(2)}
                  </td>
                  <td className="p-3 text-right tabular-nums">{row.image_count}</td>
                  <td className="p-3 text-slate-500">{row.listing_status ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * "In stock, count unknown" is shown differently from "3 in stock".
 *
 * The distinction drives the eBay quantity cap, so hiding it here would make
 * that cap look arbitrary to whoever is reviewing the listing.
 */
function StockCell({ status, qty }: { status: string; qty: number | null }) {
  if (status === 'OUT_OF_STOCK') return <span className="text-slate-400">売り切れ</span>;
  if (status === 'UNKNOWN') return <span className="text-amber-700">不明</span>;
  return (
    <span className="text-green-700 dark:text-green-400">
      {qty === null ? '在庫あり（数量非公開）' : `${qty} 点`}
    </span>
  );
}
