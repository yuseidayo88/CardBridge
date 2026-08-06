import { requireAdmin } from '@/lib/auth/require-admin';
import { PhasePlaceholder } from '@/components/phase-placeholder';

export default async function ProductsPage() {
  await requireAdmin();
  return (
    <PhasePlaceholder
      title="商品一覧"
      phase="Phase 2〜5"
      description="統合後のカタログ商品と、各店舗の仕入れ候補を一覧します。"
      features={[
        '商品画像・共通商品名・PSA判定結果',
        '店舗ごとの価格と在庫（複数仕入れ候補を並べて比較）',
        '推奨仕入れ先（実質仕入原価ベース）',
        'eBay推奨価格・想定利益・利益率',
        'AI信頼度・解析信頼度',
        '画像処理状態・出品状態・最終同期日時',
        'PSA要確認 / 相場確認が必要 / 利益条件未達 での絞り込み',
      ]}
    />
  );
}
