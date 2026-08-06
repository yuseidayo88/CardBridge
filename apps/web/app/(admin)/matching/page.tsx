import { requireAdmin } from '@/lib/auth/require-admin';
import { PhasePlaceholder } from '@/components/phase-placeholder';

export default async function MatchingPage() {
  await requireAdmin();
  return (
    <PhasePlaceholder
      title="商品統合"
      phase="Phase 3"
      description="複数店舗の同一カードを紐付けます。自動統合はスコア0.95以上かつカード番号とセットコードが両方確定している場合のみです。"
      features={[
        '自動統合済みの一覧と統合根拠（シグナル別内訳）',
        '要確認候補（スコア0.75〜0.95）の承認・却下',
        '手動統合と統合解除（履歴を残す論理削除）',
        '誤統合の検出：カード番号のみ一致は自動統合しない',
        '統合ブロッカーの表示（セットコード不一致など）',
      ]}
    />
  );
}
