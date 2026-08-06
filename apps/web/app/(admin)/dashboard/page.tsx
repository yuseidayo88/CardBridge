import { sql } from 'drizzle-orm';
import { getDb } from '@cardbridge/db';
import { requireAdmin } from '@/lib/auth/require-admin';
import { StatCard } from '@/components/stat-card';

export const dynamic = 'force-dynamic';

/**
 * Dashboard counts.
 *
 * One round trip rather than fifteen: these are all cheap aggregates, and the
 * dashboard is the most frequently loaded page in the app.
 *
 * Counts come from real tables and will read zero until Phase 2 populates them.
 * That is intentional — a dashboard showing invented sample numbers is worse
 * than one showing honest zeroes, because it hides the fact that no sync has
 * ever run.
 */
async function loadCounts() {
  const db = getDb();

  const [row] = await db.execute<{
    magi_products: string;
    cardrush_products: string;
    catalog_products: string;
    psa10_confirmed: string;
    psa_review: string;
    listing_candidates: string;
    published: string;
    out_of_stock: string;
    images_pending: string;
    images_review: string;
    match_review: string;
    sync_errors: string;
  }>(sql`
    SELECT
      (SELECT count(*) FROM supplier_products sp
        JOIN suppliers s ON s.id = sp.supplier_id
        WHERE s.code = 'magi' AND sp.disappeared_at IS NULL)          AS magi_products,
      (SELECT count(*) FROM supplier_products sp
        JOIN suppliers s ON s.id = sp.supplier_id
        WHERE s.code = 'cardrush' AND sp.disappeared_at IS NULL)      AS cardrush_products,
      (SELECT count(*) FROM catalog_products)                          AS catalog_products,
      (SELECT count(*) FROM supplier_products
        WHERE psa_verdict = 'CONFIRMED')                               AS psa10_confirmed,
      (SELECT count(*) FROM supplier_products
        WHERE psa_verdict = 'REVIEW')                                  AS psa_review,
      (SELECT count(*) FROM marketplace_listings
        WHERE status IN ('READY_FOR_REVIEW','APPROVED'))               AS listing_candidates,
      (SELECT count(*) FROM marketplace_listings
        WHERE status = 'PUBLISHED')                                    AS published,
      (SELECT count(*) FROM supplier_products
        WHERE stock_status = 'OUT_OF_STOCK')                           AS out_of_stock,
      (SELECT count(*) FROM product_images
        WHERE processing_status = 'PENDING')                           AS images_pending,
      (SELECT count(*) FROM product_images
        WHERE processing_status = 'NEEDS_REVIEW')                      AS images_review,
      (SELECT count(*) FROM match_candidates
        WHERE resolved_at IS NULL)                                     AS match_review,
      (SELECT count(*) FROM sync_jobs
        WHERE status = 'FAILED'
          AND created_at > now() - interval '24 hours')                AS sync_errors
  `);

  return row;
}

export default async function DashboardPage() {
  await requireAdmin();

  let counts: Awaited<ReturnType<typeof loadCounts>> | null = null;
  let loadError: string | null = null;
  try {
    counts = await loadCounts();
  } catch (error) {
    // A missing database should render an explanation, not a stack trace.
    loadError = error instanceof Error ? error.message : String(error);
  }

  const n = (value: string | undefined) => Number(value ?? 0);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">ダッシュボード</h1>
      <p className="mb-6 text-sm text-slate-500">
        Phase 1 時点では取得ジョブが未実装のため、各数値は 0 が正常です。
      </p>

      {loadError ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="font-medium">データベースに接続できません</div>
          <div className="mt-1 font-mono text-xs">{loadError}</div>
          <div className="mt-2">
            SUPABASE_DB_URL を確認し、supabase/migrations を適用してください。
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          <StatCard label="magi 取得商品数" value={n(counts?.magi_products)} />
          <StatCard label="カードラッシュ 取得商品数" value={n(counts?.cardrush_products)} />
          <StatCard label="統合後商品数" value={n(counts?.catalog_products)} />
          <StatCard label="PSA10 判定済み" value={n(counts?.psa10_confirmed)} tone="ok" />
          <StatCard
            label="PSA 要確認"
            value={n(counts?.psa_review)}
            tone="warn"
            href="/products?verdict=REVIEW"
          />
          <StatCard label="出品候補" value={n(counts?.listing_candidates)} />
          <StatCard label="出品中" value={n(counts?.published)} tone="ok" />
          <StatCard label="在庫切れ" value={n(counts?.out_of_stock)} tone="neutral" />
          <StatCard
            label="画像処理待ち"
            value={n(counts?.images_pending)}
            href="/images?status=PENDING"
          />
          <StatCard
            label="画像 手動確認"
            value={n(counts?.images_review)}
            tone="warn"
            href="/images?status=NEEDS_REVIEW"
          />
          <StatCard
            label="統合 要確認"
            value={n(counts?.match_review)}
            tone="warn"
            href="/matching"
          />
          <StatCard
            label="同期エラー (24h)"
            value={n(counts?.sync_errors)}
            tone={n(counts?.sync_errors) > 0 ? 'danger' : 'neutral'}
          />
        </div>
      )}
    </div>
  );
}
