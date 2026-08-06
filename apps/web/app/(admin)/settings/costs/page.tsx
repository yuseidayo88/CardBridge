import { requireAdmin } from '@/lib/auth/require-admin';
import { PhasePlaceholder } from '@/components/phase-placeholder';

export default async function CostSettingsPage() {
  await requireAdmin();
  return (
    <PhasePlaceholder
      title="コスト・配送設定"
      phase="Phase 5"
      description="手数料率や送料はコードに固定せず、すべてここから設定します。利益計算は計算時点の設定スナップショットを保存します。"
      features={[
        'eBayカテゴリー手数料・固定手数料・国際手数料',
        'Promoted Listings広告費・為替スプレッド・為替変動引当',
        '返品引当・梱包費・その他費用',
        '国内送料（店舗→発送拠点）・発送目安',
        '国際送料テーブル（配送会社・サービス・重量帯・価格帯・販売国）',
        '関税設定（BUYER_PAID / SELLER_PAID / MARKETPLACE_COLLECTED / CARRIER_QUOTE_REQUIRED / MANUAL_REVIEW）',
        '最低利益額・最低利益率・高額商品閾値',
      ]}
    />
  );
}
