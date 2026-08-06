import { sql } from 'drizzle-orm';
import { getDb } from '@cardbridge/db';
import { requireAdmin } from '@/lib/auth/require-admin';

export const dynamic = 'force-dynamic';

interface SupplierRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  base_url: string;
  is_enabled: boolean;
  trust_score: string;
  permission_notes: string | null;
  selectors: Record<string, unknown>;
  category_urls: string[];
  fetch_interval_minutes: number;
  max_pages_per_run: number;
  min_request_interval_ms: number;
  max_concurrency: number;
  safety_stock: number;
  domestic_shipping_fee_jpy: string;
  lead_time_days: number;
  reliability_score: string;
  last_synced_at: string | null;
  last_sync_error: string | null;
  adapter_healthy: boolean;
  adapter_health_checked_at: string | null;
  product_count: string;
}

async function loadSuppliers() {
  const db = getDb();
  return db.execute<SupplierRow>(sql`
    SELECT s.id, s.code, s.name, s.base_url, s.is_enabled, s.trust_score, s.permission_notes,
           ss.selectors, ss.category_urls, ss.fetch_interval_minutes, ss.max_pages_per_run,
           ss.min_request_interval_ms, ss.max_concurrency, ss.safety_stock,
           ss.domestic_shipping_fee_jpy, ss.lead_time_days, ss.reliability_score,
           ss.last_synced_at, ss.last_sync_error, ss.adapter_healthy, ss.adapter_health_checked_at,
           (SELECT count(*) FROM supplier_products sp
             WHERE sp.supplier_id = s.id AND sp.disappeared_at IS NULL) AS product_count
    FROM suppliers s
    LEFT JOIN supplier_settings ss ON ss.supplier_id = s.id
    ORDER BY s.code
  `);
}

export default async function SuppliersPage() {
  await requireAdmin();

  let rows: SupplierRow[] = [];
  let error: string | null = null;
  try {
    rows = [...(await loadSuppliers())];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="max-w-5xl">
      <h1 className="mb-1 text-2xl font-semibold">仕入れ先管理</h1>
      <p className="mb-6 text-sm text-slate-500">
        セレクター設定は DB に保存され、HTML 構造が変わった場合もこの行を直すだけで対応できます。
      </p>

      {error ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="font-medium">データベースに接続できません</div>
          <div className="mt-1 font-mono text-xs">{error}</div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {rows.map((row) => (
            <SupplierCard key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function SupplierCard({ row }: { row: SupplierRow }) {
  const configured = row.selectors && Object.keys(row.selectors).length > 0;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-medium">{row.name}</h2>
            <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">
              {row.code}
            </code>
            {row.is_enabled ? (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800 dark:bg-green-900/40 dark:text-green-300">
                有効
              </span>
            ) : (
              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-700">
                無効
              </span>
            )}
          </div>
          <a
            href={row.base_url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-slate-500 hover:underline"
          >
            {row.base_url} ↗
          </a>
        </div>
        <div className="text-right text-sm">
          <div className="text-2xl font-semibold tabular-nums">
            {Number(row.product_count).toLocaleString('ja-JP')}
          </div>
          <div className="text-xs text-slate-500">取得済み商品</div>
        </div>
      </div>

      {/*
        The most important thing this page can say. Selectors ship empty because
        the partner sites were unreachable when this was built, and an operator
        needs to know that the adapter is waiting on configuration rather than
        quietly finding nothing.
      */}
      {!configured ? (
        <div className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="font-medium">セレクター未設定のため同期できません</div>
          <div className="mt-1">
            実サイトへ到達できる環境で以下を実行し、出力レポートをもとに
            <code className="mx-1 rounded bg-amber-100 px-1">supplier_settings.selectors</code>
            を設定してください。
          </div>
          <pre className="mt-2 overflow-x-auto rounded bg-amber-100 p-2 text-xs">
            pnpm research:snapshot --supplier {row.code} --all{'\n'}
            pnpm research:analyze
          </pre>
        </div>
      ) : null}

      {row.last_sync_error ? (
        <div className="mb-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <div className="font-medium">直近の同期エラー</div>
          <div className="mt-1 font-mono text-xs">{row.last_sync_error}</div>
        </div>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm md:grid-cols-3">
        <Item label="取得間隔" value={`${row.fetch_interval_minutes} 分`} />
        <Item label="最大ページ数" value={String(row.max_pages_per_run)} />
        <Item label="リクエスト間隔" value={`${row.min_request_interval_ms} ms`} />
        <Item label="同時実行" value={String(row.max_concurrency)} />
        <Item label="安全在庫" value={String(row.safety_stock)} />
        <Item
          label="国内送料"
          value={`¥${Number(row.domestic_shipping_fee_jpy).toLocaleString('ja-JP')}`}
        />
        <Item label="発送目安" value={`${row.lead_time_days} 日`} />
        <Item label="信頼度" value={Number(row.reliability_score).toFixed(2)} />
        <Item label="優先度" value={Number(row.trust_score).toFixed(0)} />
        <Item
          label="アダプター状態"
          value={row.adapter_healthy ? '正常' : '要確認'}
          tone={row.adapter_healthy ? undefined : 'warn'}
        />
        <Item label="最終同期" value={formatDate(row.last_synced_at)} />
        <Item label="カテゴリURL" value={`${(row.category_urls ?? []).length} 件`} />
      </dl>

      {row.permission_notes ? (
        <div className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800">
          <span className="font-medium">利用許諾: </span>
          {row.permission_notes}
        </div>
      ) : null}
    </div>
  );
}

function Item({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className={tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : ''}>{value}</dd>
    </div>
  );
}

function formatDate(value: string | null): string {
  if (!value) return '未実施';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
}
