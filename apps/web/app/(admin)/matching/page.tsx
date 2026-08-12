import { sql } from 'drizzle-orm';
import { getDb } from '@cardbridge/db';
import { requireAdmin } from '@/lib/auth/require-admin';
import { approveMatch, rejectMatch, unmatchProduct } from '@/app/actions/matching';

/**
 * The merge review queue.
 *
 * The scorer refuses to auto-merge on a card number alone and vetoes — rather
 * than merely penalising — a disagreement about set code, number, grade, grader
 * or language. Everything that reaches this screen is therefore a pair that
 * genuinely needs a person, and the screen's job is to show why it scored what
 * it did rather than just how much.
 */

export const dynamic = 'force-dynamic';

interface CandidateRow extends Record<string, unknown> {
  id: string;
  score: string;
  signals: Record<string, unknown>;
  blockers: string[];
  supplier_title: string;
  supplier_code: string;
  supplier_url: string;
  supplier_price: string;
  catalog_name_ja: string;
  catalog_name_en: string | null;
  catalog_number: string | null;
  catalog_set: string | null;
  catalog_grade: string;
  catalog_grader: string;
}

interface MatchRow extends Record<string, unknown> {
  id: string;
  match_score: string;
  match_method: string;
  matched_by: string | null;
  supplier_title: string;
  supplier_code: string;
  catalog_name_ja: string;
  catalog_name_en: string | null;
}

async function loadCandidates() {
  return getDb().execute<CandidateRow>(sql`
    SELECT mc.id, mc.score, mc.signals, mc.blockers,
           sp.raw_title AS supplier_title, s.code AS supplier_code,
           sp.canonical_url AS supplier_url, sp.price_incl_tax_jpy AS supplier_price,
           c.card_name_ja AS catalog_name_ja, c.card_name_en AS catalog_name_en,
           c.card_number AS catalog_number, c.set_name AS catalog_set,
           c.grade AS catalog_grade, c.grading_company AS catalog_grader
    FROM match_candidates mc
    JOIN supplier_products sp ON sp.id = mc.supplier_product_id
    JOIN suppliers s ON s.id = sp.supplier_id
    JOIN catalog_products c ON c.id = mc.catalog_product_id
    WHERE mc.resolved_at IS NULL
    ORDER BY mc.score DESC
    LIMIT 50
  `);
}

async function loadMatches() {
  return getDb().execute<MatchRow>(sql`
    SELECT pm.id, pm.match_score, pm.match_method, pm.matched_by,
           sp.raw_title AS supplier_title, s.code AS supplier_code,
           c.card_name_ja AS catalog_name_ja, c.card_name_en AS catalog_name_en
    FROM product_matches pm
    JOIN supplier_products sp ON sp.id = pm.supplier_product_id
    JOIN suppliers s ON s.id = sp.supplier_id
    JOIN catalog_products c ON c.id = pm.catalog_product_id
    WHERE pm.unmatched_at IS NULL
    ORDER BY pm.matched_at DESC
    LIMIT 50
  `);
}

/** Signal names as they appear in the scorer, in plain Japanese. */
const SIGNAL_LABELS: Record<string, string> = {
  nameSimilarity: '名前の一致',
  numberMatch: 'カード番号',
  setCodeMatch: 'セット記号',
  rarityMatch: 'レアリティ',
  gradeMatch: 'グレード',
  graderMatch: '鑑定会社',
  languageMatch: '言語',
  yearMatch: '発売年',
};

function Signals({ signals }: { signals: Record<string, unknown> }) {
  const entries = Object.entries(signals ?? {});
  if (entries.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {entries.map(([key, value]) => {
        const label = SIGNAL_LABELS[key] ?? key;
        const numeric = typeof value === 'number' ? value : null;
        const good = numeric === null ? value === true : numeric >= 0.8;

        return (
          <span
            key={key}
            className={`rounded px-1.5 py-0.5 text-xs ${
              good
                ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100'
                : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
            }`}
          >
            {label}
            {numeric !== null ? ` ${numeric.toFixed(2)}` : ''}
          </span>
        );
      })}
    </div>
  );
}

export default async function MatchingPage({
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

  let candidates: CandidateRow[] = [];
  let matches: MatchRow[] = [];
  let dbError: string | null = null;

  try {
    [candidates, matches] = await Promise.all([loadCandidates(), loadMatches()]);
  } catch (error) {
    dbError = error instanceof Error ? error.message : String(error);
  }

  const error = first('error');

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">商品統合</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          別々の店舗の出品が同じ1枚かどうかを判断します。
          <strong>カード番号だけでは統合しません。</strong>
          セット記号・番号・グレード・鑑定会社・言語のいずれかが食い違う組み合わせは、
          点数を下げるのではなく<strong>統合対象から除外</strong>されます。
          ここに出てくるのは、それでも人の判断が要る組み合わせだけです。
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

      {/* --- pending ------------------------------------------------------- */}
      <section>
        <h2 className="mb-3 font-semibold">
          判断待ち
          <span className="ml-2 text-sm font-normal text-slate-500">{candidates.length} 件</span>
        </h2>

        {candidates.length === 0 ? (
          <p className="rounded-lg border border-slate-200 py-8 text-center text-sm text-slate-500 dark:border-slate-700">
            判断待ちの候補はありません。
          </p>
        ) : (
          <div className="space-y-3">
            {candidates.map((candidate) => (
              <div
                key={candidate.id}
                className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
              >
                <div className="mb-3 flex items-start justify-between gap-4">
                  <div className="text-sm">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs dark:bg-slate-800">
                      {candidate.supplier_code}
                    </span>
                    <span className="ml-2">{candidate.supplier_title}</span>
                    <div className="mt-1 text-xs text-slate-500">
                      ¥{Number(candidate.supplier_price).toLocaleString('ja-JP')} ·{' '}
                      <a
                        href={candidate.supplier_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        商品ページ
                      </a>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-lg font-semibold">
                      {(Number(candidate.score) * 100).toFixed(0)}
                    </div>
                    <div className="text-xs text-slate-500">スコア</div>
                  </div>
                </div>

                <div className="rounded bg-slate-50 p-3 text-sm dark:bg-slate-800">
                  <div className="text-xs text-slate-500">統合先の候補</div>
                  <div className="mt-0.5">
                    {candidate.catalog_name_ja}
                    {candidate.catalog_name_en ? (
                      <span className="ml-2 text-slate-500">/ {candidate.catalog_name_en}</span>
                    ) : (
                      <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">
                        英語名なし
                      </span>
                    )}
                  </div>
                  <div className="mt-1 font-mono text-xs text-slate-500">
                    {candidate.catalog_set ?? '—'} · {candidate.catalog_number ?? '—'} ·{' '}
                    {candidate.catalog_grader} {candidate.catalog_grade}
                  </div>
                </div>

                <Signals signals={candidate.signals} />

                {Array.isArray(candidate.blockers) && candidate.blockers.length > 0 ? (
                  <div className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100">
                    <span className="font-semibold">自動統合できない理由: </span>
                    {candidate.blockers.join(' / ')}
                  </div>
                ) : null}

                <div className="mt-3 flex gap-2">
                  <form action={approveMatch}>
                    <input type="hidden" name="candidateId" value={candidate.id} />
                    <button
                      type="submit"
                      className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
                    >
                      同じカードとして統合
                    </button>
                  </form>
                  <form action={rejectMatch}>
                    <input type="hidden" name="candidateId" value={candidate.id} />
                    <button
                      type="submit"
                      className="rounded border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600"
                    >
                      別のカード
                    </button>
                  </form>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  「別のカード」も記録されます。記録しないと、次回の同期で同じ組み合わせが
                  また出てきて、待ち行列が減りません。
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* --- established --------------------------------------------------- */}
      <section>
        <h2 className="mb-3 font-semibold">
          統合済み
          <span className="ml-2 text-sm font-normal text-slate-500">{matches.length} 件</span>
        </h2>

        {matches.length === 0 ? (
          <p className="rounded-lg border border-slate-200 py-8 text-center text-sm text-slate-500 dark:border-slate-700">
            統合済みの商品はありません。
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-700">
                  <th className="p-2">仕入れ先の出品</th>
                  <th className="p-2">統合先</th>
                  <th className="p-2">方法</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {matches.map((match) => (
                  <tr key={match.id} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="p-2">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs dark:bg-slate-800">
                        {match.supplier_code}
                      </span>
                      <span className="ml-2">{match.supplier_title}</span>
                    </td>
                    <td className="p-2">{match.catalog_name_en ?? match.catalog_name_ja}</td>
                    <td className="p-2 text-xs text-slate-500">
                      {match.match_method === 'AUTO' ? '自動' : '手動'}
                      {match.matched_by ? ` · ${match.matched_by}` : ''}
                    </td>
                    <td className="p-2 text-right">
                      <form action={unmatchProduct}>
                        <input type="hidden" name="matchId" value={match.id} />
                        <button type="submit" className="text-xs text-red-600 underline">
                          統合を解除
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">
          統合の解除は行を消さず、解除の記録を残します。
          記録が残らないと、誤った自動統合が次の同期で黙って再発し、
          一度おかしくなったことすら分からなくなります。
        </p>
      </section>
    </div>
  );
}
