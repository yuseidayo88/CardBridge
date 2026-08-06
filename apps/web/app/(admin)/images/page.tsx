import { requireAdmin } from '@/lib/auth/require-admin';
import { PhasePlaceholder } from '@/components/phase-placeholder';

export default async function ImagesPage() {
  await requireAdmin();
  return (
    <PhasePlaceholder
      title="画像確認"
      phase="Phase 4"
      description="元画像と処理後画像を比較し、マスク位置を確認・修正して手動承認します。ORIGINAL 以外の方式は、この画面での承認なしに本番出品へ進めません。"
      features={[
        '元画像・処理後画像の並列表示',
        'マスク領域の可視化と座標の手動修正',
        '処理方式の切り替え（ORIGINAL / SOURCE_REDACTED / BLACK_MASK / BLUR / CROP）',
        '検出信頼度と検出器別の内訳（幾何・バーコード・OCR の合議）',
        'カード本体を隠していないかの安全検証結果',
        'eBayポリシー警告の表示',
        '手動承認（承認者と日時を記録）',
      ]}
    />
  );
}
