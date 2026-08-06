import { requireAdmin } from '@/lib/auth/require-admin';
import { PhasePlaceholder } from '@/components/phase-placeholder';

export default async function SystemSettingsPage() {
  await requireAdmin();
  return (
    <PhasePlaceholder
      title="システム設定"
      phase="Phase 1〜7"
      description="安全装置と各種しきい値を管理します。Dry Run の解除には環境変数側の同意も必要です（設定だけでは本番出品は有効になりません）。"
      features={[
        'Dry Run の有効・無効と現在の実効状態',
        '本番出品許可（ALLOW_PRODUCTION_PUBLISH との合議結果を表示）',
        '1回あたりの最大出品数',
        '解析信頼度・AI信頼度・画像処理信頼度のしきい値',
        '自動統合スコアしきい値',
        'eBay数量上限（初期値 1）',
        '画像処理方式の既定値と本番許可方式',
        '発送拠点・相場データの必要件数',
      ]}
    />
  );
}
