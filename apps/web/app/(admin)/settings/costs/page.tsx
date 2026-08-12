import { sql } from 'drizzle-orm';
import { getDb } from '@cardbridge/db';
import { requireAdmin } from '@/lib/auth/require-admin';
import { deactivateCostProfile, saveCostProfile } from '@/app/actions/costs';

/**
 * Fee and cost settings.
 *
 * The seeded profile carries PLACEHOLDER rates on purpose — a made-up 13.25%
 * that looks plausible is worse than an obviously empty field, because it
 * produces margins nobody questions. This screen exists to replace them with
 * what the seller's own account actually charges.
 */

export const dynamic = 'force-dynamic';

interface ProfileRow extends Record<string, unknown> {
  id: string;
  name: string;
  category_fee_percent: string;
  fixed_fee_per_order: string;
  international_fee_percent: string;
  ad_rate_percent: string;
  fx_spread_percent: string;
  fx_buffer_percent: string;
  return_reserve_percent: string;
  packaging_cost: string;
  packaging_currency: string;
  other_cost: string;
  is_active: boolean;
  notes: string | null;
}

async function loadProfiles() {
  return getDb().execute<ProfileRow>(sql`
    SELECT id, name, category_fee_percent, fixed_fee_per_order, international_fee_percent,
           ad_rate_percent, fx_spread_percent, fx_buffer_percent, return_reserve_percent,
           packaging_cost, packaging_currency, other_cost, is_active, notes
    FROM cost_profiles
    ORDER BY is_active DESC, effective_from DESC
  `);
}

const INPUT =
  'w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono dark:border-slate-600 dark:bg-slate-800';

/** Fields shared by the create and edit forms, so the two cannot drift apart. */
const FIELDS: Array<{
  name: keyof ProfileRow & string;
  label: string;
  hint: string;
  unit: '%' | '額';
}> = [
  {
    name: 'category_fee_percent',
    label: '落札手数料',
    hint: 'カテゴリ別の Final Value Fee。送料を含む総額に対する率',
    unit: '%',
  },
  {
    name: 'international_fee_percent',
    label: '国際取引手数料',
    hint: '購入者が販売者と別の国に登録している場合の上乗せ',
    unit: '%',
  },
  {
    name: 'ad_rate_percent',
    label: 'プロモーション広告料率',
    hint: 'Promoted Listings。使っていなければ 0',
    unit: '%',
  },
  {
    name: 'fx_spread_percent',
    label: '為替スプレッド',
    hint: '入金を円転する際に差し引かれる率。これは手数料',
    unit: '%',
  },
  {
    name: 'fx_buffer_percent',
    label: '為替変動バッファ',
    hint: '出品から入金までの変動に備える予備。手数料ではなくリスク留保',
    unit: '%',
  },
  {
    name: 'return_reserve_percent',
    label: '返品引当',
    hint: '返品コストを全売上に薄く配分した率',
    unit: '%',
  },
  { name: 'fixed_fee_per_order', label: '注文ごとの固定費', hint: '1注文あたり', unit: '額' },
  { name: 'packaging_cost', label: '梱包資材費', hint: 'スリーブ・箱・緩衝材', unit: '額' },
  { name: 'other_cost', label: 'その他費用', hint: '上のどれにも当たらないもの', unit: '額' },
];

function Field({ field, value }: { field: (typeof FIELDS)[number]; value?: string }) {
  return (
    <label className="text-sm">
      <span className="block">
        {field.label}
        <span className="ml-1 text-xs text-slate-500">{field.unit === '%' ? '(%)' : ''}</span>
      </span>
      <input
        name={toCamel(field.name)}
        defaultValue={value ?? '0'}
        inputMode="decimal"
        className={INPUT}
      />
      <span className="mt-0.5 block text-xs text-slate-500">{field.hint}</span>
    </label>
  );
}

function toCamel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** A seeded row still carrying its placeholder marker has never been reviewed. */
function isPlaceholder(row: ProfileRow): boolean {
  return (row.notes ?? '').toUpperCase().includes('PLACEHOLDER');
}

export default async function CostSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();

  const params = await searchParams;
  const first = (key: string): string | null => {
    const value = params[key];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  };

  let profiles: ProfileRow[] = [];
  let dbError: string | null = null;
  try {
    profiles = await loadProfiles();
  } catch (error) {
    dbError = error instanceof Error ? error.message : String(error);
  }

  const error = first('error');
  const saved = first('saved') ?? first('created');
  const unreviewed = profiles.filter((p) => p.is_active && isPlaceholder(p));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">コスト・配送設定</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          手数料率はコードに一切書かれていません。eBay は料率を改定しますし、
          もっともらしい固定値は、利益率が静かにずれ始めてから数か月気づかれません。
          利益計算は使用したプロファイルのスナップショットを保存するので、
          ここを編集しても過去の判断の記録は書き換わりません。
        </p>
      </div>

      {dbError ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <div className="font-semibold">データベースに接続できません</div>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs">{dbError}</pre>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100">
          {error}
        </div>
      ) : null}

      {saved ? (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100">
          保存しました。
        </div>
      ) : null}

      {unreviewed.length > 0 ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <div className="font-semibold">
            仮の値のままのプロファイルが {unreviewed.length} 件あります
          </div>
          <p className="mt-1">
            シードに入っている料率は<strong>実際の値ではありません</strong>。 eBay
            セラーアカウントの請求明細で確認した値に置き換えてください。
            置き換えるまで、利益計算の結果は参考値です。
          </p>
        </div>
      ) : null}

      {/* --- existing profiles -------------------------------------------- */}
      {profiles.map((profile) => (
        <section
          key={profile.id}
          className={`rounded-lg border p-4 ${
            profile.is_active
              ? 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900'
              : 'border-slate-200 bg-slate-50 opacity-60 dark:border-slate-800 dark:bg-slate-950'
          }`}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="font-semibold">
              {profile.name}
              {profile.is_active ? null : (
                <span className="ml-2 text-xs font-normal text-slate-500">（無効）</span>
              )}
              {isPlaceholder(profile) ? (
                <span className="ml-2 rounded bg-amber-200 px-1.5 py-0.5 text-xs font-normal text-amber-900">
                  仮の値
                </span>
              ) : null}
            </h2>
            {profile.is_active ? (
              <form action={deactivateCostProfile}>
                <input type="hidden" name="id" value={profile.id} />
                <button type="submit" className="text-xs text-slate-500 underline">
                  無効にする
                </button>
              </form>
            ) : null}
          </div>

          <form action={saveCostProfile} className="space-y-4">
            <input type="hidden" name="id" value={profile.id} />

            <label className="block text-sm">
              プロファイル名
              <input name="name" defaultValue={profile.name} className={INPUT} />
            </label>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {FIELDS.map((field) => (
                <Field key={field.name} field={field} value={String(profile[field.name] ?? '0')} />
              ))}
            </div>

            <label className="block text-sm">
              梱包費の通貨
              <select
                name="packagingCurrency"
                defaultValue={profile.packaging_currency}
                className={INPUT}
              >
                <option value="JPY">JPY</option>
                <option value="USD">USD</option>
              </select>
            </label>

            <label className="block text-sm">
              メモ
              <textarea
                name="notes"
                defaultValue={profile.notes ?? ''}
                rows={2}
                className={INPUT}
              />
              <span className="mt-0.5 block text-xs text-slate-500">
                実際の値に更新したら、メモから PLACEHOLDER の記載を消してください。
                この画面の警告表示はそれを見ています。
              </span>
            </label>

            <button
              type="submit"
              className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
            >
              保存する
            </button>
          </form>
        </section>
      ))}

      {/* --- new ----------------------------------------------------------- */}
      <section className="rounded-lg border border-dashed border-slate-300 p-4 dark:border-slate-700">
        <h2 className="mb-3 font-semibold">プロファイルを追加</h2>
        <form action={saveCostProfile} className="space-y-4">
          <label className="block text-sm">
            プロファイル名
            <input name="name" required placeholder="eBay US 2026" className={INPUT} />
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {FIELDS.map((field) => (
              <Field key={field.name} field={field} />
            ))}
          </div>

          <label className="block text-sm">
            梱包費の通貨
            <select name="packagingCurrency" defaultValue="JPY" className={INPUT}>
              <option value="JPY">JPY</option>
              <option value="USD">USD</option>
            </select>
          </label>

          <label className="block text-sm">
            メモ
            <textarea name="notes" rows={2} className={INPUT} />
          </label>

          <button
            type="submit"
            className="rounded border border-slate-300 px-4 py-2 text-sm font-medium dark:border-slate-600"
          >
            追加する
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm dark:border-slate-700 dark:bg-slate-900">
        <h2 className="mb-2 font-semibold">関税について</h2>
        <p className="text-slate-600 dark:text-slate-400">
          米国向けの関税は <code>CARRIER_QUOTE_REQUIRED</code> です。
          <strong>金額を作りません。</strong>2025年8月29日に $800 の de minimis
          免除が撤廃され、少額貨物にも課税されるようになりました。
          税率は品目と原産国で変わり、実額は配送業者の見積りでしか確定しません。
          もっともらしい数字を置くと、利益が出ていない出品が利益ありとして通ります。
        </p>
      </section>
    </div>
  );
}
