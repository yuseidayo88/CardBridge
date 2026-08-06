import { requireAdmin } from '@/lib/auth/require-admin';
import { PhasePlaceholder } from '@/components/phase-placeholder';

export default async function SuppliersPage() {
  await requireAdmin();
  return (
    <PhasePlaceholder
      title="仕入れ先管理"
      phase="Phase 2"
      description="店舗ごとの取得設定、セレクター、安全在庫、国内送料を管理します。"
      features={[
        '店舗一覧と有効・無効の切り替え',
        '取得間隔・同時実行数・リクエスト間隔の設定',
        'セレクター設定の編集（HTML構造変更時はここだけを直す）',
        '安全在庫・国内送料・店舗手数料・発送目安日数',
        'アダプター健全性（セレクター生存確認）と最終同期日時',
        '同期エラーの表示と再実行',
        '利用許可メモ（画像利用・自動取得・eBay販売の許諾内容）',
      ]}
    />
  );
}
