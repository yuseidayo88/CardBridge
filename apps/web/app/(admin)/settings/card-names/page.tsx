import { sql } from 'drizzle-orm';
import { getDb } from '@cardbridge/db';
import { requireAdmin } from '@/lib/auth/require-admin';
import {
  addCardName,
  deleteCardName,
  importCardNames,
  verifyCardName,
} from '@/app/actions/card-names';

/**
 * The card name table's operator surface.
 *
 * This screen is what makes an AI key optional. cardNameEn is the one field
 * that blocks title generation, and a Japanese name cannot be transformed into
 * an official English one — it has to be looked up or typed. Everything here
 * exists so that "looked up or typed" is a workable amount of work.
 */

export const dynamic = 'force-dynamic';

interface CardNameRow extends Record<string, unknown> {
  id: string;
  name_ja: string;
  name_en: string;
  set_code: string | null;
  card_number: string | null;
  source: string;
  is_verified: boolean;
  verified_by: string | null;
  note: string | null;
}

async function loadRows(search: string | null) {
  const db = getDb();
  const pattern = search ? `%${search}%` : null;

  // Unverified first: those are the rows that still need a decision, and a
  // screen that buries them under a thousand finished ones is a screen where
  // the import never gets finished.
  return db.execute<CardNameRow>(sql`
    SELECT id, name_ja, name_en, set_code, card_number, source, is_verified, verified_by, note
    FROM card_names
    WHERE ${pattern}::text IS NULL
       OR name_ja ILIKE ${pattern} OR name_en ILIKE ${pattern}
    ORDER BY is_verified ASC, name_ja ASC
    LIMIT 200
  `);
}

async function loadCounts() {
  const db = getDb();
  const rows = await db.execute<{ total: string; verified: string }>(sql`
    SELECT count(*) AS total, count(*) FILTER (WHERE is_verified) AS verified FROM card_names
  `);
  return {
    total: Number(rows[0]?.total ?? 0),
    verified: Number(rows[0]?.verified ?? 0),
  };
}

const INPUT =
  'w-full rounded border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800';

export default async function CardNamesPage({
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

  const search = first('q');

  let rows: CardNameRow[] = [];
  let counts = { total: 0, verified: 0 };
  let dbError: string | null = null;

  try {
    [rows, counts] = await Promise.all([loadRows(search), loadCounts()]);
  } catch (error) {
    dbError = error instanceof Error ? error.message : String(error);
  }

  const error = first('error');
  const imported = first('imported');

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">カード名対応表</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          日本語カード名から eBay 用の公式英語名を引くための表です。 「リザードンex → Charizard
          ex」は変換ではなく<strong>照合</strong>なので、
          文字列処理では出せません。ここに登録があれば AI なしで英語名が決まります。
        </p>
      </div>

      {dbError ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <div className="font-semibold">データベースに接続できません</div>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs">{dbError}</pre>
          <p className="mt-2">
            Supabase の設定（<code>SUPABASE_DB_URL</code>）と、
            <code>supabase/migrations/</code> の適用状況を確認してください。
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100">
          {error}
        </div>
      ) : null}

      {imported ? (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100">
          {imported} 件を取り込みました（重複 {first('skipped') ?? 0} 件はスキップ）。
          取り込んだ行は<strong>未確認</strong>
          です。確認するまで、自動出品に必要な信頼度には達しません。
          {first('rejected') ? (
            <div className="mt-1">列が足りない行: {first('rejected')}</div>
          ) : null}
        </div>
      ) : null}

      <div className="flex gap-4 text-sm">
        <div className="rounded border border-slate-200 px-3 py-2 dark:border-slate-700">
          登録 <span className="font-mono font-semibold">{counts.total}</span> 件
        </div>
        <div className="rounded border border-slate-200 px-3 py-2 dark:border-slate-700">
          確認済み <span className="font-mono font-semibold">{counts.verified}</span> 件
        </div>
      </div>

      {/* --- add ---------------------------------------------------------- */}
      <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="mb-3 font-semibold">1件追加</h2>
        <form action={addCardName} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-sm">
            日本語名 <span className="text-red-600">*</span>
            <input name="nameJa" required placeholder="リザードンex" className={INPUT} />
          </label>
          <label className="text-sm">
            英語名 <span className="text-red-600">*</span>
            <input name="nameEn" required placeholder="Charizard ex" className={INPUT} />
          </label>
          <label className="text-sm">
            セット記号
            <input name="setCode" placeholder="sv3a" className={INPUT} />
          </label>
          <label className="text-sm">
            カード番号
            <input name="cardNumber" placeholder="006/165" className={INPUT} />
          </label>
          <label className="text-sm sm:col-span-2">
            メモ
            <input name="note" className={INPUT} />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
            >
              追加する
            </button>
            <p className="mt-2 text-xs text-slate-500">
              セット記号とカード番号を入れると、その刷りだけに適用されます。
              空欄なら「セットを問わずこの名前」という行になります。
              手入力の行は確認済みとして登録されます。
            </p>
          </div>
        </form>
      </section>

      {/* --- import ------------------------------------------------------- */}
      <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="mb-1 font-semibold">まとめて取り込み</h2>
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
          1行につき <code>日本語名 → 英語名 → セット記号 → カード番号</code> の順。
          タブ区切り（表計算からのコピー）またはカンマ区切り。後ろ2列は省略できます。
        </p>
        <form action={importCardNames} className="space-y-3">
          <textarea
            name="rows"
            rows={6}
            required
            placeholder={'リザードンex\tCharizard ex\tsv3a\t006/165\nピカチュウ\tPikachu'}
            className="w-full rounded border border-slate-300 p-2 font-mono text-xs dark:border-slate-600 dark:bg-slate-800"
          />
          <button
            type="submit"
            className="rounded border border-slate-300 px-4 py-2 text-sm font-medium dark:border-slate-600"
          >
            取り込む
          </button>
        </form>
      </section>

      {/* --- list --------------------------------------------------------- */}
      <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="font-semibold">登録内容</h2>
          <form className="flex gap-2">
            <input
              name="q"
              defaultValue={search ?? ''}
              placeholder="名前で検索"
              className="rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800"
            />
            <button type="submit" className="text-sm underline">
              検索
            </button>
          </form>
        </div>

        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">
            {search ? '一致する行がありません。' : 'まだ1件も登録されていません。'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-700">
                  <th className="py-2 pr-3">日本語名</th>
                  <th className="py-2 pr-3">英語名</th>
                  <th className="py-2 pr-3">セット</th>
                  <th className="py-2 pr-3">番号</th>
                  <th className="py-2 pr-3">状態</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-2 pr-3">{row.name_ja}</td>
                    <td className="py-2 pr-3 font-medium">{row.name_en}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{row.set_code ?? '—'}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{row.card_number ?? '—'}</td>
                    <td className="py-2 pr-3">
                      {row.is_verified ? (
                        <span
                          className="text-emerald-700 dark:text-emerald-400"
                          title={row.verified_by ?? ''}
                        >
                          確認済み
                        </span>
                      ) : (
                        <span className="text-amber-700 dark:text-amber-400">未確認</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex justify-end gap-3">
                        {row.is_verified ? null : (
                          <form action={verifyCardName}>
                            <input type="hidden" name="id" value={row.id} />
                            <button type="submit" className="text-xs underline">
                              確認する
                            </button>
                          </form>
                        )}
                        <form action={deleteCardName}>
                          <input type="hidden" name="id" value={row.id} />
                          <button type="submit" className="text-xs text-red-600 underline">
                            削除
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 200 ? (
              <p className="mt-3 text-xs text-slate-500">
                200件まで表示しています。検索で絞り込んでください。
              </p>
            ) : null}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm dark:border-slate-700 dark:bg-slate-900">
        <h2 className="mb-2 font-semibold">照合の精度について</h2>
        <table className="w-full">
          <tbody className="text-slate-600 dark:text-slate-400">
            <tr>
              <td className="py-1 pr-4 font-mono text-xs">名前＋セット＋番号</td>
              <td>確定。そのまま出品に使えます</td>
            </tr>
            <tr>
              <td className="py-1 pr-4 font-mono text-xs">名前＋番号</td>
              <td>ほぼ確定</td>
            </tr>
            <tr>
              <td className="py-1 pr-4 font-mono text-xs">名前のみ</td>
              <td>
                <strong>自動出品はしません</strong>。同名カードは複数セットに再録されるためです
              </td>
            </tr>
            <tr>
              <td className="py-1 pr-4 font-mono text-xs">英語名が複数該当</td>
              <td>値を返しません。人が選びます</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}
