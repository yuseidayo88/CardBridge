import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@cardbridge/db';
import { requireAdmin } from '@/lib/auth/require-admin';
import { loadSettings } from '@/lib/settings';
import { VerdictBadge } from '@/components/verdict-badge';

export const dynamic = 'force-dynamic';

interface ProductDetail extends Record<string, unknown> {
  id: string;
  raw_title: string;
  canonical_url: string;
  supplier_code: string;
  supplier_name: string;
  price_incl_tax_jpy: string;
  stock_qty: number | null;
  stock_status: string;
  psa_verdict: string;
  psa_evidence: Array<{ signal: string; found: boolean; weight: number; detail: string }>;
  parse_warnings: Array<{ code: string; message: string; severity: string }>;
  parse_confidence: string;
  raw_payload: Record<string, unknown>;
  first_seen_at: string;
  last_checked_at: string;
  disappeared_at: string | null;
}

async function loadProduct(id: string): Promise<ProductDetail | null> {
  const db = getDb();
  const rows = await db.execute<ProductDetail>(sql`
    SELECT sp.*, s.code AS supplier_code, s.name AS supplier_name
    FROM supplier_products sp
    JOIN suppliers s ON s.id = sp.supplier_id
    WHERE sp.id = ${id}
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function loadHistory(id: string) {
  const db = getDb();
  const [prices, stock] = await Promise.all([
    db.execute<{ price_incl_tax_jpy: string; observed_at: string }>(sql`
      SELECT price_incl_tax_jpy, observed_at FROM price_history
      WHERE supplier_product_id = ${id} ORDER BY observed_at DESC LIMIT 20
    `),
    db.execute<{ stock_qty: number | null; stock_status: string; observed_at: string }>(sql`
      SELECT stock_qty, stock_status::text AS stock_status, observed_at FROM stock_history
      WHERE supplier_product_id = ${id} ORDER BY observed_at DESC LIMIT 20
    `),
  ]);
  return { prices: [...prices], stock: [...stock] };
}

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const settings = await loadSettings();

  let product: ProductDetail | null = null;
  let history = { prices: [] as never[], stock: [] as never[] };
  let error: string | null = null;

  try {
    product = await loadProduct(id);
    if (product) history = (await loadHistory(id)) as never;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) {
    return (
      <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        <div className="font-medium">データベースに接続できません</div>
        <div className="mt-1 font-mono text-xs">{error}</div>
      </div>
    );
  }
  if (!product) notFound();

  return (
    <div className="max-w-5xl">
      <Link href="/products" className="text-sm text-slate-500 hover:underline">
        ← 商品一覧
      </Link>

      <div className="mt-2 mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{product.raw_title}</h1>
          <div className="mt-1 flex items-center gap-3 text-sm text-slate-500">
            <span>{product.supplier_name}</span>
            <a
              href={product.canonical_url}
              target="_blank"
              rel="noreferrer noopener"
              className="hover:underline"
            >
              元ページ ↗
            </a>
          </div>
        </div>
        <VerdictBadge verdict={product.psa_verdict} />
      </div>

      {/* The approval control lives here, but it is disabled until every
          precondition is met — and the reasons are listed rather than implied. */}
      <ApprovalPanel
        dryRun={settings.dryRun}
        verdict={product.psa_verdict}
        parseConfidence={Number(product.parse_confidence)}
        minParseConfidence={settings.minParseConfidence}
      />

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Section title="仕入れ情報">
          <Field
            label="税込価格"
            value={`¥${Number(product.price_incl_tax_jpy).toLocaleString('ja-JP')}`}
          />
          <Field
            label="在庫"
            value={
              product.stock_status === 'IN_STOCK'
                ? product.stock_qty === null
                  ? '在庫あり（店舗が数量を公開していません）'
                  : `${product.stock_qty} 点`
                : product.stock_status === 'OUT_OF_STOCK'
                  ? '売り切れ'
                  : '不明'
            }
          />
          <Field label="解析信頼度" value={Number(product.parse_confidence).toFixed(2)} />
          <Field label="初回取得" value={formatDate(product.first_seen_at)} />
          <Field label="最終確認" value={formatDate(product.last_checked_at)} />
          {product.disappeared_at ? (
            <Field label="掲載終了" value={formatDate(product.disappeared_at)} />
          ) : null}
        </Section>

        <Section title="PSA10 判定の根拠">
          <p className="mb-3 text-xs text-slate-500">
            発火しなかったシグナルも含めて表示します。タイトルの記載だけでは確定しません。
          </p>
          <ul className="flex flex-col gap-1.5 text-sm">
            {(product.psa_evidence ?? []).map((e, i) => (
              <li key={i} className="flex gap-2">
                <span className={e.found ? 'text-green-600' : 'text-slate-300'}>
                  {e.found ? '✓' : '−'}
                </span>
                <span className={e.found ? '' : 'text-slate-400'}>{e.detail}</span>
              </li>
            ))}
            {(product.psa_evidence ?? []).length === 0 ? (
              <li className="text-slate-400">根拠が記録されていません</li>
            ) : null}
          </ul>
        </Section>
      </div>

      {(product.parse_warnings ?? []).length > 0 ? (
        <div className="mt-6">
          <Section title="解析時の警告">
            <ul className="flex flex-col gap-2 text-sm">
              {product.parse_warnings.map((w, i) => (
                <li key={i} className="flex gap-2">
                  <span
                    className={
                      w.severity === 'ERROR'
                        ? 'font-medium text-red-700'
                        : 'font-medium text-amber-700'
                    }
                  >
                    {w.code}
                  </span>
                  <span className="text-slate-600 dark:text-slate-300">{w.message}</span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      ) : null}

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Section title="価格履歴">
          <HistoryList
            rows={history.prices.map((p: { price_incl_tax_jpy: string; observed_at: string }) => ({
              when: p.observed_at,
              what: `¥${Number(p.price_incl_tax_jpy).toLocaleString('ja-JP')}`,
            }))}
          />
        </Section>
        <Section title="在庫履歴">
          <HistoryList
            rows={history.stock.map(
              (s: { stock_qty: number | null; stock_status: string; observed_at: string }) => ({
                when: s.observed_at,
                what: `${s.stock_status}${s.stock_qty === null ? '' : ` (${s.stock_qty})`}`,
              }),
            )}
          />
        </Section>
      </div>

      <div className="mt-6">
        <Section title="生データ">
          <pre className="overflow-x-auto rounded bg-slate-50 p-3 text-xs dark:bg-slate-800">
            {JSON.stringify(product.raw_payload, null, 2)}
          </pre>
        </Section>
      </div>
    </div>
  );
}

/**
 * The approval control.
 *
 * Rendered disabled with its reasons listed, rather than hidden. An operator
 * who cannot see why they are unable to approve something assumes the tool is
 * broken; one who can see "PSA verdict is REVIEW" knows what to do next.
 */
function ApprovalPanel({
  dryRun,
  verdict,
  parseConfidence,
  minParseConfidence,
}: {
  dryRun: boolean;
  verdict: string;
  parseConfidence: number;
  minParseConfidence: number;
}) {
  const blockers: string[] = [];
  if (dryRun) blockers.push('Dry Run が有効です（eBay への書き込みは行われません）');
  if (verdict !== 'CONFIRMED') blockers.push('PSA10 判定が確定していません');
  if (parseConfidence < minParseConfidence) {
    blockers.push(
      `解析信頼度 ${parseConfidence.toFixed(2)} が基準 ${minParseConfidence} を下回っています`,
    );
  }
  // These are not yet produced by any pipeline stage, so they always block.
  blockers.push('画像処理が未実施です');
  blockers.push('利益計算が未実施です');
  blockers.push('英語タイトル・説明が未生成です');

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-2 text-sm font-medium">出品承認</div>
      <ul className="mb-3 flex flex-col gap-1 text-sm text-slate-600 dark:text-slate-300">
        {blockers.map((blocker) => (
          <li key={blocker} className="flex gap-2">
            <span className="text-red-600">×</span>
            <span>{blocker}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled
        className="cursor-not-allowed rounded bg-slate-200 px-4 py-2 text-sm font-medium text-slate-500 dark:bg-slate-700"
      >
        eBay へ出品する（条件未達）
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <h2 className="mb-3 text-sm font-medium">{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 py-1.5 text-sm last:border-0 dark:border-slate-800">
      <span className="text-slate-500">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

function HistoryList({ rows }: { rows: Array<{ when: string; what: string }> }) {
  if (rows.length === 0) {
    return <p className="text-sm text-slate-400">記録がありません</p>;
  }
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {rows.map((row, i) => (
        <li key={i} className="flex justify-between gap-4">
          <span className="text-slate-500">{formatDate(row.when)}</span>
          <span className="tabular-nums">{row.what}</span>
        </li>
      ))}
    </ul>
  );
}

function formatDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
}
