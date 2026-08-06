# CardBridge 設計提案書 (v0.1 / 実装前レビュー用)

PSA10 ポケモンカード 国内仕入 → eBay 出品 半自動管理システム

> 本書は実装開始前のレビュー用ドキュメントです。承認後に Phase 1 から着手します。

---

## 0. 調査環境の制約（最初に開示すべき事実）

本セッションの実行環境は組織のエグレスポリシー配下にあり、以下のホストへの
アウトバウンド接続が **ゲートウェイ側で 403** となり到達できませんでした。

| ホスト                                  | 結果                   | 備考                             |
| --------------------------------------- | ---------------------- | -------------------------------- |
| `www.magicardshop.jp`                   | 403 (CONNECT rejected) | サイト側ではなくプロキシ側の拒否 |
| `www.cardrush-pokemon.jp`               | 403 (CONNECT rejected) | 同上                             |
| `www.ebay.com` (ポリシーページ)         | 403                    | WebFetch 全面不可                |
| `developer.ebay.com` (API ドキュメント) | 403                    | WebFetch 全面不可                |
| `en.wikipedia.org` (疎通テスト)         | 403                    | WebFetch 自体が環境で無効        |

利用できたのは Web 検索のみです。したがって本書のうち

- **eBay 仕様** … 公式ドキュメントの内容を検索結果経由で取得（出典明記、二次情報を含む）
- **対象2サイトの HTML 構造** … **未検証**。実地調査の「手順」を定義するに留める

という区別をしています。プロキシを迂回する第三者ミラーの利用は、
組織ポリシーの回避に当たるため行っていません。

**必要なアクション**: 上記2ドメイン + `developer.ebay.com` + `api.ebay.com` を
セッションのエグレス許可リストへ追加していただくか、
`docs/research/` 配下に HTML スナップショットを配置していただければ、
セレクタ確定まで一気に進められます。

---

## 1. 要件理解

### 1.1 システムの本質

本システムは「スクレイパー」でも「出品ツール」でもなく、
**国内仕入価格と eBay 実売相場の差分から、利益の出る裁定機会を検出し、
人間の承認を経て出品・同期する意思決定支援システム**です。

したがって設計の重心は次の3点に置きます。

1. **不確実性を握り潰さないこと** — 推測値と確定値をデータ構造レベルで分離する
   （`value` / `source` / `confidence` の三つ組）。不明は `null` であり、
   AI に埋めさせない。
2. **可逆性と段階承認** — Dry Run 既定 ON。本番 eBay への書き込みは
   明示承認 + 二段階確認を通過した経路以外に存在させない（型レベルで封じる）。
3. **店舗差の隔離** — 店舗固有の知識は Supplier Adapter とその設定に閉じ込め、
   ドメイン層・UI 層に一切漏らさない。3店舗目の追加が「1ファイル + 1レコード」で済む形。

### 1.2 スコープの確認

| 対象         | 内容                                                                 |
| ------------ | -------------------------------------------------------------------- |
| 対象商品     | ポケモンカード **PSA10 シングルのみ**                                |
| 対象外       | PSA9 以下、未鑑定、BOX、パック、サプライ、他 TCG                     |
| 提携先       | magi通販 / カードラッシュ（画像利用・自動取得・eBay 販売の許諾あり） |
| MVP の到達点 | 半自動。承認済み商品のみ eBay Sandbox → 少数 Production 出品         |
| MVP 非対象   | 提携先への自動発注、完全自動出品、在庫の自動再仕入                   |

### 1.3 用語の定義（以降で厳密に使い分ける）

- **supplier_product** … ある店舗が売っている「その店の在庫1件」。価格・在庫を持つ。
- **catalog_product** … 物理的なカードの同一性（カード名/番号/セット/言語/鑑定/グレード）。
  価格・在庫を持たない。
- **marketplace_listing** … eBay 上の1オファー。catalog_product に 1:1 で紐づく。
- **仕入候補** … 1つの catalog_product に紐づく複数の supplier_product。

---

## 2. 対象サイト調査方針

実地アクセスができないため、**調査そのものをコード化**します。
「人間がセレクタを目視で決めてハードコードする」のではなく、
**HTML スナップショットを取得 → 構造を自動診断 → 設定 YAML を生成 → 固定化**
という手順にします。これは HTML 構造変更時の再調査にもそのまま再利用できます。

### 2.1 調査手順（Phase 2 冒頭で実行）

```
scripts/research/snapshot.ts <url>
  → docs/research/<supplier>/<hash>.html に保存（1回だけ取得、以降キャッシュ）
  → 同時に以下を自動抽出してレポート化:
     - <script type="application/ld+json"> の有無と Product スキーマの充足度
     - OGP / meta / microdata (itemprop) の有無
     - ページネーション形式（?page= / /page/N / 無限スクロール）
     - 商品カードの繰り返し DOM 構造の推定（同一クラス名の反復検出）
     - JS 描画依存度の判定（no-JS HTML に商品名が含まれるか）
     - 在庫表示文言の候補抽出（「在庫」「売切」「SOLD OUT」「残り」等）
     - 画像 URL パターンと解像度バリエーション
     - HTTP ヘッダ: ETag / Last-Modified / Cache-Control の有無
```

### 2.2 判定ロジック（Playwright を使うか否か）

```
no-JS の HTML に商品名・価格・在庫が含まれる
  → undici (fetch) + cheerio のみ。Playwright は使わない（既定）
含まれない、または一部のみ
  → 一覧は cheerio、詳細の欠損項目のみ Playwright（限定利用）
```

要件どおり **軽い方法を優先**します。Playwright は依存関係が重く、
実行コストとブロック率が上がるため、必要性が実証されるまで導入しません。

### 2.3 現時点で分かっていること / 仮説

- 両サイトとも `/product-group/{id}` という**同一の URL 体系**を持ちます
  （magi: `/product-group/14`、カードラッシュ: `/product-group/277`）。
  これは両者が**同一の EC カートシステム（TCG 専業向け SaaS と推測）**を
  使っている可能性を強く示唆します。
  → もし同一基盤なら、`GenericCartAdapter` を1つ作り、
  `MagiAdapter` / `CardRushAdapter` はその**設定差分**として表現できます。
  これは3店舗目以降の追加コストを劇的に下げます。**要検証**。
- カードラッシュには `/group` （カテゴリ一覧）が存在することを検索結果で確認。
- 商品詳細 URL の形式は未確認（`/product/{id}` と推測、要検証）。

### 2.4 URL 正規化方針

```
入力: https://www.cardrush-pokemon.jp/product-group/277?sort=new&page=2&utm_source=x
正規化:
  1. スキームを https に固定、ホストを設定値に正規化（www 有無を統一）
  2. 許可リスト外のクエリを全削除（utm_*, sort, view, ref 等）
  3. ページングは正規 URL とは別に「取得パラメータ」として保持（DB の URL 欄には入れない）
  4. 末尾スラッシュ・大文字小文字を正規化
  5. 結果を canonical_url として保存。<link rel="canonical"> があればそれを優先
```

### 2.5 サイトへの配慮（提携許可があっても厳守）

| 項目                    | 設定値（初期）                                                         |
| ----------------------- | ---------------------------------------------------------------------- |
| 同時実行数              | **1**（店舗ごと）                                                      |
| リクエスト間隔          | **3秒**（jitter ±1秒）                                                 |
| 1回の同期の最大ページ数 | 設定可（初期 20）                                                      |
| 詳細ページ取得          | **差分のみ**（一覧のハッシュが変化した商品だけ）                       |
| 条件付きリクエスト      | `If-None-Match` / `If-Modified-Since` を送信、304 は即スキップ         |
| 画像                    | `original_image_hash` で重複排除。同一画像は再取得しない               |
| リトライ                | 最大3回、指数バックオフ（2s/4s/8s）、5xx と 429 のみ                   |
| 実行時間帯              | 深夜帯（JST 2:00-6:00）を既定のフルスキャン枠に                        |
| robots.txt              | 起動時に取得・尊重（提携許可があっても既定は尊重、上書きは設定で明示） |
| User-Agent              | 連絡先 URL 入りの固定 UA。偽装しない                                   |

---

## 3. eBay 公式仕様の調査結果

### 3.1 確認できた事実（出典付き）

#### コンディションとコンディションディスクリプタ

- トレカ3カテゴリ **183050 / 183454 / 261328** では、
  Item Condition は **Graded (Condition ID 2750)** か **Ungraded (4000)** のみ。
  他の condition は受理されない。
  → 日本語ポケカ = **183454 (CCG Individual Cards)** を想定（要最終確認）
- Condition 2750/4000 使用時は `conditionDescriptors` 配列が**必須**。
- ディスクリプタ ID:
  - `27501` = Professional Grader（必須）
  - `27502` = Grade（必須）
  - `27503` = Certification Number（**任意**、`additionalInfo` に自由入力）
- Inventory API のペイロード形（検索結果より）:

```json
{
  "conditionDescriptors": [
    { "name": "27501", "values": ["275010"] },
    { "name": "27502", "values": ["10"] },
    { "name": "27503", "additionalInfo": "A233434" }
  ]
}
```

- 対応グレーダーに **PSA** を含む（BGS/CGC/SGC/BVG/CSG/KSA/GMA/HGA/ISA 等も）。

> **重要な運用判断**: `275010` (PSA) や grade 値 `10` を含む**すべての ID を
> ハードコードしません**。起動時および日次で **Metadata API
> `getItemConditionPolicies`** を叩き、`ebay_condition_policies` テーブルへ
> キャッシュし、そこから解決します。要件どおり「想像でハードコードしない」を
> コードレベルで担保します。Item Specifics も同様に
> `getItemAspectsForCategory` から動的取得します。

- **Certification Number は任意** → 代表画像運用（画像の認証番号と実物が異なる）を
  取る場合は **27503 を送信しない**という選択が API 上は可能。
  実物と紐づけて出品する場合のみ送信する、という設計にします。

#### タイトル

- 出品タイトルは **80文字上限**（超過は ErrorCode 70）。
  eBay 自身は 55 文字程度を推奨するという情報もあり、
  80 を上限、65-75 を目標レンジとして生成します。

#### 販売済み価格データ

- **Marketplace Insights API**（過去90日の販売実績）は **Limited Release**。
  現在 **新規申請を受け付けていない**とされ、Business 承認 (Application Growth
  Check) が前提。
- 旧 **Finding API の `findCompletedItems` は 2025年2月に廃止**。
- **Browse API は現行出品のみ**で、販売済みデータの代替にならない。

> **結論**: MVP で「公式 API による販売済み価格」の取得は**期待できません**。
> かつ eBay の販売済みページのスクレイピングは eBay 利用規約違反となるため
> **採用しません**。代替は §11 に記載。

#### レート制限

- Sell 系 API の既定は概ね **1日 25,000 コール**（API により異なる）。
  Application Growth Check で引き上げ可能。
- 自アプリの実制限は **Developer Analytics API `getUserRateLimits`** で
  取得できるため、**実測値をもとにレート制御**します（固定値を書かない）。

#### Authenticity Guarantee (AG)

- トレカ AG の閾値は **$250 → $200 に引き下げ**。graded / raw 双方が対象。
- 対象要件に「**写真2枚以上**」を含む。
- ただし **米国本土のセラーから米国本土のバイヤーへの ebay.com 上の取引**が条件。
  → **日本発送のセラーは AG 対象外**。
  つまり「認証センター経由の物流」は不要な一方、
  **eBay 側の真贋担保が付かない**ため、画像の説得力がそのまま
  コンバージョンと SNAD リスクに直結します（画像方式の判断に効く）。

#### 税・関税

- EU 向け ≤€150 の輸入は **IOSS によりマーケットプレイス（eBay）が VAT を徴収**。
  UK・AU・NZ 等も marketplace facilitator ルールで同様。
  → `MARKETPLACE_COLLECTED` モードが実在の運用形態として必要。
- **米国の de minimis($800免税) は 2025年8月29日に撤廃**。
  → 低価格帯でも米国向けは関税が発生しうる。
  「安いカードだから関税なし」という前提は**もう成立しません**。
  DDP/DAP の選択と関税引当を、**販売国 × 価格帯 × 配送手段**で
  テーブル駆動にする必然性がここにあります。

### 3.2 確認しきれなかった項目（Phase 7 の Sandbox 実測で確定）

| 項目                            | 確定方法                                |
| ------------------------------- | --------------------------------------- |
| 日本語ポケカの正確なカテゴリ ID | `getCategorySuggestions` + Sandbox 実測 |
| PSA の grader value ID          | `getItemConditionPolicies`              |
| grade 10 の value ID            | 同上                                    |
| 必須 Item Specifics 一覧        | `getItemAspectsForCategory`             |
| Inventory API の実レート制限    | `getUserRateLimits`                     |
| Picture Policy の逐条文言       | **§4 参照。要ユーザー確認**             |

---

## 4. 画像黒塗りに関するポリシー評価

### 4.1 調査結果

公式ポリシーページ (`ebay.com/help/policies/listing-policies/picture-policy`) には
本環境から到達できませんでした（403）。以下は検索経由で得られた内容であり、
**逐条の一次確認が未了**であることを明示します。

| 論点              | 得られた情報                                                                                       | 黒塗りへの含意                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 枠線・ボーダー    | **追加ボーダーは全面禁止**                                                                         | 黒塗りは「ボーダー」ではない → 直接は非該当                                            |
| 透かし            | 所有者表示目的は可だが、**画像の主要部への重畳は不可**。面積5%以下・不透明度50%以下が目安          | 黒矩形は「透かし」の定義には当たらないが、**主要部への重畳禁止**の趣旨は近い           |
| テキスト          | **セラー宣伝目的のテキストは不可**。ユーザーID/著作権表記は50%不透明度で可                         | 黒塗りに文字を入れない限り非該当                                                       |
| 商品を隠す要素    | **商品を隠すプレースホルダ、商品を覆うプロモーション用オーバーレイ、商品を遮る透かしは禁止**       | **ここが最大の論点**。黒矩形は「商品の一部（ラベル）を覆うオーバーレイ」と解釈されうる |
| 正確性            | 画像は**実物を正確に表現**しなければならない                                                       | ラベル情報の隠蔽は「正確な表現」の観点で議論の余地                                     |
| 中古/コレクタブル | **ストックフォトは新品のみ許可**。中古は実物撮影が必要                                             | PSA スラブは一点物 → **代表画像は原則不可の側**                                        |
| グレード品の写真  | **鑑定会社名/ロゴが明確に写った写真**が必要                                                        | ラベル全体のトリミング (CROP) は**この要件と衝突**                                     |
| 自動検知          | 透かし自動検知は数年前から稼働、**近年はかなり積極的**。画像の**拒否・差し替え・非表示**がありうる | 黒塗りが誤検知される運用リスクが実在                                                   |

### 4.2 評価（判断根拠）

**黒塗り (BLACK_MASK) の適法性は「明確に禁止」でも「明確に許可」でもなく、
グレーです。** 根拠は次のとおりです。

- 禁止列挙（テキスト/アートワーク/透かし/マーケティング素材/ボーダー）の
  **文言そのものには黒矩形は該当しません**。
- しかし「**商品を覆うオーバーレイ**」「**画像は実物を正確に表現**」という
  一般条項に抵触する解釈が成立しえます。
- さらに、AG 対象外の日本セラーにとって、認証番号の秘匿は
  **バイヤーが PSA サイトで真贋照合できない**ことを意味し、
  コミュニティ観測では**認証番号を隠した出品は落札価格が有意に下がる**
  という報告があります。ポリシー以前に**経済合理性が低い**可能性があります。

そして本件で**より重い問題は黒塗りではなく「代表画像」**です。

> グレード品は一点物であり、eBay は中古/コレクタブルに対して
> ストックフォト・代表画像を認めていません。
> 「画像と異なる認証番号の個体が届く」運用は、
> 免責文言を書いても **SNAD (Significantly Not As Described) 申立ての
> 構造的リスク**を残します。文言はリスクを下げますが、
> ポリシー適合を成立させるものではありません（要件のご指摘どおりです）。

### 4.3 推奨（安全側）

要件「ポリシー上問題がある可能性が高い方法を本番デフォルトにしない」に従い:

| 設定                                   | 既定値                                                       | 理由                                                            |
| -------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| `IMAGE_PROCESSING_METHOD` (production) | **`ORIGINAL`**                                               | 加工しない = ポリシー抵触リスク最小。グレーダーロゴも保持される |
| `REPRESENTATIVE_IMAGE_MODE`            | **`DISABLED`**                                               | 実物1個体 : 出品1件を厳守。eBay 数量は 1                        |
| `BLACK_MASK`                           | 実装するが**手動承認必須**の opt-in                          | 管理者が明示的に選択し、1件ずつ承認した場合のみ                 |
| `CROP`                                 | 使用可だが**ラベル全体の除去は禁止**（バリデーションで弾く） | 鑑定会社ロゴの可視性要件を守るため                              |
| `BLUR`                                 | opt-in（黒塗りより穏当だが同じグレー領域）                   | —                                                               |
| `SOURCE_REDACTED`                      | 提携先が非表示済み画像を提供する場合に使用                   | **最も安全。交渉価値が最も高い**                                |
| 管理画面表示                           | 常にマスク版を表示可（社内利用はポリシー対象外）             | 要件7を満たす                                                   |

**最推奨アクション**: 提携2社に対して
「**認証番号部分を非表示にした eBay 出品用画像の提供**」または
「**加工許諾の明文化**」を交渉してください（`SOURCE_REDACTED`）。
これはシステム側のどんな工夫よりも確実にリスクを消します。

**最終確認のお願い**: 公式 Picture Policy の逐条文言は、
恐れ入りますが以下のいずれかでご確認をお願いします。

1. 上記ドメインをエグレス許可リストへ追加していただく
2. ポリシーページのテキストを共有していただく
3. eBay Japan のセラーサポート／カテゴリ担当へ照会（**最も確実**。
   「PSA スラブの認証番号を黒塗りした画像の可否」を書面で得る）

確認が取れるまで、`BLACK_MASK` は **Sandbox とプレビューのみ**で有効とし、
Production 出品経路では選択できないようコードで封じます。

---

## 5. 推奨画像処理方式

### 5.1 方式比較

| #   | 方式                          | ポリシー risk        | バイヤー信頼 | 実装コスト       | 判定                  |
| --- | ----------------------------- | -------------------- | ------------ | ---------------- | --------------------- |
| 1   | ORIGINAL（無加工）            | **低**               | 高           | 極小             | **本番既定**          |
| 2   | BLACK_MASK                    | 中〜高               | 中〜低       | 大               | opt-in / 手動承認必須 |
| 3   | CROP                          | 中（ロゴ欠落なら高） | 中           | 中               | 条件付き可            |
| 4   | BLUR                          | 中                   | 中           | 中               | opt-in                |
| 5   | SOURCE_REDACTED               | **最低**             | 高           | 小（交渉が必要） | **最推奨・要交渉**    |
| 6   | eBay 用代表画像を別途用意     | 高（一点物）         | 低           | 中               | 不採用（既定 OFF）    |
| 7   | 管理画面=マスク / eBay=別画像 | 高                   | 低           | 中               | 不採用（既定 OFF）    |

### 5.2 黒塗りを実装する場合の設計（opt-in 経路）

要件で挙げられた考慮点をすべて設計に織り込みます。

**多段検出パイプライン（OCR 単独に依存しない）**

```
Stage 1: 画像正規化
  - EXIF 回転補正、長辺 1600px へリサイズ、余白トリム、
    知覚ハッシュ (pHash) 算出
Stage 2: スラブ検出（幾何）
  - 矩形輪郭検出でスラブ本体の四隅を推定 → 射影変換で正立化
  - スラブのアスペクト比（約 1:1.9）で妥当性検証
  - 表面/裏面の判定（ラベル帯の有無・輝度分布）
Stage 3: ラベル領域の特定（テンプレート座標）
  - 正立化後の相対座標でラベル帯を切り出し
  - PSA ラベル世代（旧ラベル/現行ラベル/Lighthouse 等）を
    テンプレートマッチングで分類 → 世代別の座標テーブルを適用
Stage 4: 対象領域の確定（複数手段の合議）
  - (a) テンプレート相対座標
  - (b) バーコード検出（zbar/ZXing）で1D バーコードの実測 bbox
  - (c) OCR（数字8桁前後の連続数字）の bbox
  → 3つの合議で信頼度を算出。2つ以上一致で confidence 高
Stage 5: 安全性検証（カード本体を隠さない）
  - マスク矩形がカード本体領域（スラブ内のラベル帯より下）と
    交差したら **即座に失敗扱い** → MANUAL_REVIEW へ
  - マスク面積が画像全体の N%（初期 8%）を超えたら失敗
Stage 6: 適用と保存
  - 元画像は絶対に上書きしない
  - processing_confidence < 閾値（初期 0.9）は自動公開せず手動確認へ
```

**保存スキーマ**（要件どおり分離）

```
product_images
  original_image_url, original_image_hash (sha256), original_phash,
  processed_image_url, processing_method, processing_status,
  mask_coordinates (jsonb: [{x,y,w,h,source,confidence}]),
  processing_confidence, manually_approved_at, manually_approved_by,
  face (FRONT|BACK|OTHER), width, height, bytes
```

`original_image_hash` を一意キーにして**同一画像の再ダウンロードを完全に排除**します
（複数店舗が同じ画像を使っている場合にも効きます）。

---

## 6. 複数仕入れ先対応アーキテクチャ

### 6.1 レイヤ構成

```
┌──────────────────────────────────────────────┐
│ apps/web  (Next.js App Router / 管理画面)      │  ← 表示と承認のみ
├──────────────────────────────────────────────┤
│ apps/worker (Node 常駐 / ジョブ実行)           │  ← 取得・画像・同期
├──────────────────────────────────────────────┤
│ packages/core   ドメイン層（純粋関数・副作用なし）│
│   parsing / matching / pricing / profit /      │
│   listing-eligibility / sku                    │
├──────────────────────────────────────────────┤
│ packages/adapters  SupplierAdapter 実装群       │  ← 店舗知識はここだけ
│ packages/ebay      eBay API クライアント        │
│ packages/imaging   sharp ベース画像処理          │
│ packages/ai        AI 生成 + スキーマ検証        │
│ packages/db        Drizzle スキーマ / RLS       │
└──────────────────────────────────────────────┘
```

**依存の向き**: `adapters` → `core` の一方向のみ。
`core` は adapters を知りません。店舗を増やしても `core` は変更不要です。

### 6.2 SupplierAdapter インターフェース（拡張版）

ご提示のインターフェースをベースに、実運用で必要になる要素を足しています。

```ts
export interface SupplierAdapter {
  readonly supplierCode: string;
  readonly capabilities: SupplierCapabilities;

  fetchProductList(o?: FetchOptions): AsyncIterable<SupplierProductRaw>;
  fetchProductDetail(sourceProductId: string): Promise<SupplierProductDetailRaw>;
  checkStock(ids: string[]): Promise<SupplierStockResult[]>; // バッチ化
  checkPrice(ids: string[]): Promise<SupplierPriceResult[]>; // バッチ化
  normalizeUrl(url: string): string;
  extractSourceProductId(url: string, html?: string): string | null;
  healthCheck(): Promise<AdapterHealth>; // セレクタ生存確認
}

export interface SupplierCapabilities {
  hasExactStockCount: boolean; // false なら eBay 数量を 1 に固定
  hasStructuredData: boolean; // JSON-LD 等
  supportsConditionalGet: boolean;
  requiresJsRendering: boolean;
  maxConcurrency: number;
  minRequestIntervalMs: number;
}
```

主な変更理由:

- `fetchProductList` を **AsyncIterable** に。全件をメモリに載せず、
  ページ単位でストリーム処理・途中中断ができます。
- `checkStock/checkPrice` を **バッチ**に。1商品1リクエストは
  サイト負荷の観点で許容できません。
- **`capabilities`** を追加。「在庫数が取れない店では eBay 数量を 1 以上にしない」
  という要件を、アダプターの申告からドメイン層が自動で適用できます。
- **`healthCheck`** を追加。HTML 構造変更を出品事故の前に検知します。

### 6.3 セレクタの外部化

店舗固有の知識は **DB の `supplier_settings.selectors` (jsonb)** と
`packages/adapters/<code>/config.ts` に隔離し、
アダプター本体のコードは「設定を解釈する薄い層」に留めます。

```jsonc
{
  "listUrlTemplate": "https://www.example.jp/product-group/{groupId}",
  "pagination": { "type": "query", "param": "page", "start": 1, "maxPages": 20 },
  "selectors": {
    "productCard": ".product-list .item",
    "name": ".item-name",
    "price": ".item-price",
    "stock": ".item-stock",
    "link": "a.item-link",
    "image": "img.item-thumb",
  },
  "stockRules": [
    { "match": "SOLD OUT", "status": "OUT_OF_STOCK" },
    { "match": "残り(\\d+)点", "status": "IN_STOCK", "captureQty": 1 },
    { "match": "在庫あり", "status": "IN_STOCK", "qty": null },
  ],
}
```

HTML 構造が変わったら **この JSON だけを直す**（アプリの再デプロイ不要）。
これが要件「アプリ全体を修正せず対応できるように」への回答です。

### 6.4 将来のアダプター

`CsvSupplierAdapter` / `ApiSupplierAdapter` / `GenericScrapingSupplierAdapter`
は同一インターフェースを実装するだけで追加できます。
`GenericScrapingSupplierAdapter` は §6.3 の設定 JSON のみで動くため、
**コードを書かずに店舗追加**が可能になります（3店舗目以降の本命）。

---

## 7. DB 設計案

### 7.1 設計原則

- 巨大 `products` を作らない。**店舗固有 / 共通カタログ / 出品**を三分割。
- 金額は `numeric(20,6)` で保存し、アプリ層は **decimal.js** で扱う。
  JS の `number` は金額計算に一切使いません（ESLint ルールで機械的に禁止）。
- 履歴系（価格・在庫）は**追記のみ**。上書きしない。
- すべての AI 由来・解析由来の値は `{value, source, confidence}` を保持。

### 7.2 テーブル一覧

**仕入れ先**

| テーブル                      | 主な列                                                                                                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `suppliers`                   | code, name, is_enabled, base_url, trust_score, notes_permission (利用許諾メモ)                                                                                                                                                                              |
| `supplier_settings`           | supplier_id, selectors jsonb, stock_rules jsonb, fetch_interval_min, safety_stock, domestic_shipping_fee, handling_fee, lead_time_days, max_concurrency, min_interval_ms, priority                                                                          |
| `supplier_products`           | supplier_id, source_product_id (UQ w/ supplier), canonical_url, raw_title, price_incl_tax, stock_qty (nullable), stock_status, first_seen_at, last_checked_at, raw_payload jsonb, parse_warnings jsonb, parse_confidence, content_hash, etag, last_modified |
| `supplier_product_attributes` | supplier_product_id, field, value, source, confidence （※ card_name/number/set/rarity/year/language/grader/grade を三つ組で保持）                                                                                                                           |

**カタログ**

| テーブル           | 主な列                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog_products` | card_name_ja, card_name_en, card_number, set_code, set_name, rarity, release_year, language, grading_company, grade, match_key, is_verified |
| `product_matches`  | catalog_product_id, supplier_product_id, match_score, match_method (AUTO/MANUAL), matched_by, matched_at, unmatched_at                      |

**画像**

| テーブル                | 主な列                                                            |
| ----------------------- | ----------------------------------------------------------------- |
| `product_images`        | §5.2 のとおり                                                     |
| `image_processing_jobs` | image_id, method, status, attempts, error, detector_results jsonb |

**マーケットプレイス**

| テーブル                  | 主な列                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `marketplaces`            | code (EBAY_US 等), currency, is_enabled                                                                                        |
| `marketplace_listings`    | catalog_product_id, marketplace_id, sku, ebay_offer_id, ebay_listing_id, status, price, quantity, published_at, last_synced_at |
| `ebay_condition_policies` | category_id, payload jsonb, fetched_at （Metadata API キャッシュ）                                                             |
| `ebay_aspect_policies`    | category_id, payload jsonb, fetched_at                                                                                         |
| `ebay_credentials`        | account, refresh_token_enc, access_token_enc, expires_at, scopes, env (SANDBOX/PROD)                                           |

**コストと利益**

| テーブル              | 主な列                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cost_profiles`       | name, marketplace_id, fee_percent, fixed_fee, intl_fee_percent, ad_rate, fx_spread, fx_buffer, return_reserve, packaging_cost, insurance, is_active, effective_from |
| `shipping_rules`      | country, carrier, service, weight_from/to, price_from/to, cost, buyer_charged, signature_option                                                                     |
| `customs_rules`       | country, mode (BUYER_PAID/SELLER_PAID/MARKETPLACE_COLLECTED/CARRIER_QUOTE_REQUIRED/MANUAL_REVIEW), rate_percent, threshold, notes                                   |
| `profit_calculations` | catalog_product_id, marketplace_id, scenario (OPTIMISTIC/BASE/PESSIMISTIC), 各費目, profit, margin, **settings_snapshot jsonb**, calculated_at                      |
| `market_prices`       | catalog_product_id, marketplace_id, source, sold_median, sold_count, active_min, active_median, sample_window_days, collected_at, is_sufficient                     |

**運用**

| テーブル                          | 主な列                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `price_history` / `stock_history` | supplier_product_id, value, observed_at（追記のみ）                                                                          |
| `sync_jobs`                       | type, supplier_id, status, lock_key (UQ), started_at, finished_at, stats jsonb                                               |
| `sync_logs`                       | job_id, level, message, context jsonb                                                                                        |
| `ai_generations`                  | target_type, target_id, model, prompt_hash, input jsonb, output jsonb, schema_valid, confidence, warnings jsonb, cost_tokens |
| `app_settings`                    | key, value jsonb, updated_by, updated_at（Dry Run フラグ等）                                                                 |
| `audit_logs`                      | actor, action, target, before jsonb, after jsonb, ip, at                                                                     |

### 7.3 同一商品マッチング

```
match_key = normalize(lower(card_name_en|card_name_ja))
          + '|' + card_number + '|' + set_code
          + '|' + language + '|' + grading_company + '|' + grade
```

- **ブロッキング**: `card_number` + `language` + `grade` で候補を絞る
- **スコアリング**: カード名の類似度（正規化編集距離）、セットコード一致、
  レアリティ一致、年一致 を重み付け合算
- **自動統合は score ≥ 0.95 かつ card_number と set_code が両方確定している場合のみ**
- `card_number` のみ一致は**統合しない**（誤統合防止の要件に直結）。
  番号は異なるセット間で重複するためです。
- 0.75 ≤ score < 0.95 は **`MANUAL_REVIEW`** として管理画面に候補提示
- 手動統合・解除は `product_matches` に `unmatched_at` を立てる論理削除で、
  **履歴を残したまま**取り消せる形にします。

### 7.4 RLS

全テーブルで RLS 有効。`admin` ロールのみ全アクセス。
匿名・authenticated には**一切の権限を与えない**（管理画面は
サーバー側で Service Role を使い、ユーザー権限は Next.js 側で検証）。
Service Role Key はサーバー環境変数のみ。クライアントバンドルには
`NEXT_PUBLIC_` 接頭辞の付いた anon key すら**不要**な設計にします
（全 DB アクセスを Server Actions / Route Handlers 経由に限定）。

---

## 8. ディレクトリ構成案

```
CardBridge/
├── apps/
│   ├── web/                        # Next.js 15 App Router
│   │   ├── app/
│   │   │   ├── (auth)/login/
│   │   │   ├── (admin)/
│   │   │   │   ├── dashboard/
│   │   │   │   ├── suppliers/
│   │   │   │   ├── products/[id]/
│   │   │   │   ├── images/[id]/
│   │   │   │   ├── matching/
│   │   │   │   ├── settings/costs/
│   │   │   │   ├── settings/shipping/
│   │   │   │   └── settings/system/
│   │   │   └── api/
│   │   │       ├── jobs/trigger/route.ts
│   │   │       └── webhooks/ebay/route.ts
│   │   ├── components/ui/          # shadcn/ui
│   │   └── lib/auth/, lib/actions/
│   └── worker/                     # ジョブ実行（常駐）
│       ├── src/jobs/
│       │   ├── sync-suppliers.ts
│       │   ├── process-images.ts
│       │   ├── generate-ai-content.ts
│       │   ├── refresh-market-prices.ts
│       │   └── sync-ebay-listings.ts
│       └── src/scheduler.ts
├── packages/
│   ├── core/
│   │   ├── parsing/     (title-parser, psa-detector, normalizers)
│   │   ├── matching/    (blocking, scoring, merge-rules)
│   │   ├── pricing/     (sourcing-selector, min-price-solver)
│   │   ├── profit/      (cost-model, scenarios, fx)
│   │   ├── listing/     (eligibility, sku, title-builder)
│   │   └── types/
│   ├── adapters/
│   │   ├── base/        (SupplierAdapter, http-client, rate-limiter, cache)
│   │   ├── magi/
│   │   ├── cardrush/
│   │   └── generic/
│   ├── ebay/
│   │   ├── auth/        (oauth, token-store, refresh)
│   │   ├── inventory/   (item, offer, publish, withdraw)
│   │   ├── metadata/    (condition-policies, aspects)
│   │   ├── account/     (business-policies, locations)
│   │   └── guard/       (dry-run-guard, idempotency, retry)
│   ├── imaging/         (sharp pipeline, slab-detect, mask, hash)
│   ├── ai/              (client, schemas, prompts, validator)
│   └── db/              (drizzle schema, migrations, rls policies)
├── docs/
│   ├── design/          # 本書
│   ├── research/        # HTML スナップショットと調査レポート
│   └── phases/          # 各フェーズの完了報告
├── scripts/research/
├── supabase/migrations/
└── (pnpm-workspace.yaml, turbo.json, vitest.workspace.ts, ...)
```

---

## 9. 実装フェーズ

ご提示の 9 フェーズをほぼ踏襲します（1点だけ順序を変更）。

| Phase  | 内容                                                                                     | 変更点                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1      | monorepo 基盤 / Supabase / Auth / DB スキーマ / 管理画面シェル / Dry Run ガード          | —                                                                                                            |
| 2      | Adapter 基盤 / **サイト実地調査** / magi・カードラッシュ取得 / 共通形式変換 / 同期ログ   | 冒頭に §2.1 の調査を追加                                                                                     |
| 3      | PSA10 判定 / 商品名解析 / 同一商品統合 / 手動統合画面                                    | —                                                                                                            |
| 4      | 画像取得 / 処理候補 / マスク・トリミング / 手動確認画面 / ポリシー警告                   | —                                                                                                            |
| **5'** | **eBay Metadata API 先行接続**（カテゴリ・Condition Descriptor・Aspects の実データ取得） | **Phase 7 から前倒し**。理由: 必須項目が確定しないと §5 の利益計算も §6 のタイトル生成も仕様が固まらないため |
| 5      | コスト・配送・関税設定 / 利益計算 / 逆算価格 / シナリオ分析                              | —                                                                                                            |
| 6      | AI 英語生成 / JSON Schema 検証 / 手動編集 / 警告管理                                     | —                                                                                                            |
| 7      | eBay OAuth / Inventory API / Dry Run / **Sandbox 1商品出品**                             | Metadata 部分は 5' 済                                                                                        |
| 8      | 在庫・価格同期 / 出品停止 / 定期ジョブ / 通知 / エラー回復                               | —                                                                                                            |
| 9      | Production 接続 / 5商品 → 20商品 / 運用検証                                              | —                                                                                                            |

各フェーズ終了時に `docs/phases/phase-N.md` として
「実装内容 / 変更ファイル / 動作確認手順 / テスト結果 / 未解決事項 / 次フェーズ」
を提出します。

---

## 10. 必要な外部アカウント

| #   | アカウント                                               | 用途                                 | 備考                           |
| --- | -------------------------------------------------------- | ------------------------------------ | ------------------------------ |
| 1   | **eBay Developer Program**                               | API キー (App ID / Cert ID / Dev ID) | Sandbox + Production の2セット |
| 2   | **eBay セラーアカウント（日本）**                        | 実出品                               | Business Policies 有効化が必要 |
| 3   | **eBay Sandbox テストユーザー**                          | Sandbox 出品検証                     | 開発者ポータルで発行           |
| 4   | **Supabase**                                             | Postgres / Auth / Storage            | Storage は画像保存に使用       |
| 5   | **Anthropic API**（推奨）または OpenAI API               | 英語生成・補助解析                   | §12 で理由                     |
| 6   | **ホスティング**: Vercel (web) + Railway/Fly.io (worker) | —                                    | worker を分ける理由は §12      |
| 7   | 為替レート API（exchangerate.host / OpenExchangeRates）  | JPY↔USD 等                           | 無料枠で可                     |
| 8   | 通知チャネル（Slack Incoming Webhook 等）                | 売却時・エラー通知                   | 任意                           |

**申請に時間がかかるもの**（先に着手してください）:
eBay Production キーの承認、eBay Business Policies の有効化。

---

## 11. 必要な環境変数

すべて**サーバー専用**。`NEXT_PUBLIC_` 接頭辞は原則使いません。

```bash
# --- Supabase ---
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=        # サーバーのみ。絶対にクライアントへ出さない
SUPABASE_DB_URL=                  # Drizzle マイグレーション用

# --- 暗号化 ---
TOKEN_ENCRYPTION_KEY=             # 32byte base64。OAuth トークンの AES-256-GCM 暗号化

# --- eBay ---
EBAY_ENV=SANDBOX                  # SANDBOX | PRODUCTION（既定は SANDBOX）
EBAY_APP_ID=
EBAY_CERT_ID=
EBAY_DEV_ID=
EBAY_REDIRECT_URI=                # RuName
EBAY_MARKETPLACE_ID=EBAY_US
EBAY_FULFILLMENT_POLICY_ID=
EBAY_PAYMENT_POLICY_ID=
EBAY_RETURN_POLICY_ID=
EBAY_MERCHANT_LOCATION_KEY=

# --- 安全装置 ---
DRY_RUN=true                      # 既定 true。false 化には二段階確認が必要
ALLOW_PRODUCTION_PUBLISH=false    # DRY_RUN=false かつ true の場合のみ本番書き込み
MAX_PUBLISH_PER_RUN=5             # 暴走防止

# --- AI ---
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=
AI_MODEL=                         # モデル ID は環境変数で外出し
AI_MIN_CONFIDENCE=0.85

# --- スクレイピング ---
SCRAPER_USER_AGENT="CardBridgeBot/1.0 (+https://example.com/contact)"
SCRAPER_MAX_CONCURRENCY=1
SCRAPER_MIN_INTERVAL_MS=3000
SCRAPER_RESPECT_ROBOTS=true

# --- 為替・通知 ---
FX_API_KEY=
SLACK_WEBHOOK_URL=
```

---

## 12. 技術構成についての提案（変更点と理由）

ご提示の候補はおおむね適切です。以下 5 点のみ変更を提案します。

### 12.1 ORM: Prisma → **Drizzle ORM**

理由: (a) 生成される SQL が予測可能で **RLS と相性が良い**、
(b) バンドルサイズと起動時間が小さく worker/Edge で有利、
(c) `numeric` 型を文字列で返すため **decimal.js への受け渡しが安全**
（Prisma の Decimal は独自型で二重変換が発生）。

### 12.2 定期実行: Supabase Cron 単独 → **Cron はトリガのみ / 実処理は常駐 worker**

理由: スクレイピング（数分〜数十分）と sharp による画像処理は、
Supabase Edge Function / Vercel Serverless の**実行時間・メモリ上限に収まりません**。
構成を次のようにします。

```
Supabase pg_cron  →  jobs テーブルに enqueue（軽い）
                          ↓
Railway/Fly.io の worker が SELECT ... FOR UPDATE SKIP LOCKED で取得・実行
```

`SKIP LOCKED` + `sync_jobs.lock_key` の一意制約により、
要件の**同期ジョブ排他制御**と**重複ジョブ防止**が DB レベルで保証されます。

### 12.3 HTTP 取得: **undici + cheerio を第一選択**、Playwright は条件付き

理由は §2.2 のとおり。Playwright を入れるのは
「no-JS HTML に必要データが無い」ことを実測で確認してからにします。
未検証の段階で重い依存を入れません。

### 12.4 金額: decimal.js 採用 + **`number` 使用を機械的に禁止**

`packages/core/profit` 配下に ESLint の `no-restricted-syntax` を設定し、
金額型 `Money` 以外での算術演算をコンパイル/Lint エラーにします。
「decimal.js を使う」を規約ではなく**強制**にします。

### 12.5 AI: **Claude API（Anthropic）**を推奨

理由: (a) tool use による**構造化出力の安定性**が高く、
Zod スキーマとの往復が確実、(b) 日本語カード名の解釈と英語化の
品質が本用途に合う、(c) `warnings` を返させる指示追従性が高い。
ただし `packages/ai` は Provider インターフェースで抽象化し、
OpenAI へ差し替え可能にします。

**AI の使い方の原則**（要件どおり）:

- AI は**補助**。決定的パーサ → 店舗固有ルール → JSON-LD → AI の順で試行し、
  先に確定した値を AI で上書きしない。
- **年・カード番号・セット名を AI に推測させない**。
  プロンプトで「不明なら null を返せ」と明示し、
  さらに出力後に「入力テキストに存在しない数値が出力に現れていないか」を
  **機械的に検証**（幻覚ガード）。
- 全出力を Zod で検証。`confidence < AI_MIN_CONFIDENCE` または
  `warnings.length > 0` なら**自動出品不可**フラグを立てる。

### 12.6 実売相場データの現実解（§3.1 の帰結）

Marketplace Insights が使えない前提で、MVP は次の3層にします。

1. **Browse API**（利用可）で **現行出品**の最安・中央値・件数・外れ値を取得
2. **管理者による手動入力**（Terapeak / Seller Hub で調べた実売中央値を入力）
   — eBay の公式 UI を人間が見る行為はスクレイピングではなく問題ありません
3. データ不足時は `market_prices.is_sufficient = false` とし、
   **「相場確認が必要」表示 + 自動出品ブロック**

**採用しないもの**: eBay 販売済みページのスクレイピング（利用規約違反）、
非公式サードパーティの無許諾データ。
Marketplace Insights の申請自体は並行して行う価値があります。

---

## 13. リスクと未確定事項

### 13.1 技術的リスク

| #   | リスク                             | 影響                        | 対策                                                                                        |
| --- | ---------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| T1  | 対象サイトの HTML 構造変更         | 取得停止・誤データ          | セレクタ外部化、`healthCheck` で日次検証、取得件数の急変を検知しアラート                    |
| T2  | サイトが JS 描画必須だった         | 実装工数増                  | Phase 2 冒頭で実測。必要な部分のみ Playwright                                               |
| T3  | 商品IDが安定して取れない           | 重複登録・履歴分断          | URL・内部ID・content hash の多重化。§2.4 の正規化                                           |
| T4  | 商品名解析の精度不足               | 誤マッチ・誤出品            | 確信度閾値 + 要確認キュー。**推測しない**を徹底                                             |
| T5  | 誤統合（別カードの統合）           | 誤発送・SNAD                | card_number 単独一致では統合しない。手動解除可能                                            |
| T6  | 画像マスクの誤検出                 | カード本体を隠す/番号が残る | 多段合議 + 面積・交差の安全検証 + 低信頼は手動                                              |
| T7  | eBay API レート制限                | 同期失敗                    | `getUserRateLimits` で実測、トークンバケット制御、指数バックオフ                            |
| T8  | 為替変動                           | 利益消失                    | `fx_buffer` を必須計上。悲観シナリオで判定                                                  |
| T9  | 二重出品・二重更新                 | アカウント警告              | Idempotency Key + `sync_jobs` 排他 + SKU 一意制約                                           |
| T10 | 在庫の売り違い（国内で先に売れる） | キャンセル・評価毀損        | eBay 数量は常に 1、売却時に即数量 0、同期間隔を短く                                         |
| T11 | 秘密情報の漏洩                     | 重大                        | 全キーをサーバー限定、OAuth トークンは AES-256-GCM で暗号化保存、ログにマスク               |
| T12 | SSRF（画像 URL 経由）              | 内部ネットワーク到達        | 画像 URL は提携先ドメインの許可リストで検証、プライベート IP を拒否、リダイレクト追跡を制限 |

### 13.2 eBay ポリシー上のリスク

| #   | リスク                                     | 深刻度               | 対策                                                                             |
| --- | ------------------------------------------ | -------------------- | -------------------------------------------------------------------------------- |
| P1  | **代表画像運用**（画像と異なる個体を発送） | **高**               | 既定 OFF。実物1個体:出品1件。数量は 1                                            |
| P2  | **画像の黒塗り**                           | **中〜高（未確定）** | §4。本番既定にしない。書面確認まで Sandbox 限定                                  |
| P3  | 画像加工の自動検知による差し替え・非表示   | 中                   | ORIGINAL 既定、加工版は手動承認のみ                                              |
| P4  | Condition Descriptor の誤登録              | 中                   | Metadata API から動的取得。ハードコード禁止                                      |
| P5  | 認証番号の未記載                           | 低                   | 27503 は任意。ただし実物と紐づく場合は記載を推奨                                 |
| P6  | タイトルのキーワードスタッフィング/誇張    | 中                   | AI に禁止語リスト（authentic, rare, mint 等の根拠なき付加）を適用し、機械検証    |
| P7  | VeRO / 知的財産（ポケモン画像）            | 中                   | 提携先の許諾は「提携先の画像」に対するもの。転載元がメーカー画像でないことを確認 |
| P8  | 販売国の輸入規制・税務                     | 中                   | 販売国を初期は US に限定。国追加は個別検討                                       |
| P9  | 米国 de minimis 撤廃による関税             | **高（新規）**       | 関税を必ずコストモデルに計上。DDP/DAP を国×価格帯で設定                          |

### 13.3 未確定事項（ご判断・ご確認をお願いしたい項目）

各項目に**推奨案を併記**しています。

| #   | 未確定事項                               | 推奨案                                                                                                             |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| U1  | 対象2サイトへのアクセス手段              | エグレス許可リストへ追加。不可なら HTML スナップショットを共有                                                     |
| U2  | Picture Policy の黒塗り可否              | **eBay Japan へ書面照会**。それまで ORIGINAL 既定                                                                  |
| U3  | 提携先からの非表示処理済み画像の入手可否 | **交渉を推奨**（最もリスクが低い）                                                                                 |
| U4  | 販売対象国                               | **MVP は EBAY_US のみ**。安定後に UK/AU/DE を追加                                                                  |
| U5  | 発送手段                                 | **MVP は 1〜2 種を設定で固定**（例: FedEx / 日本郵便）。実勢送料を管理画面で入力                                   |
| U6  | 高額商品の閾値                           | **$200 を初期値**（AG 閾値と揃える。日本セラーは AG 対象外だが、バイヤー期待値の境界として妥当）。管理画面で変更可 |
| U7  | 最低利益額・最低利益率                   | **初期 ¥1,500 / 15%**。管理画面で変更可                                                                            |
| U8  | 実売相場の取得手段                       | §12.6 の3層。Marketplace Insights は並行申請                                                                       |
| U9  | 発送拠点                                 | 国内送料の計算に必須。住所（都道府県）をご教示ください                                                             |
| U10 | eBay セラーアカウントの既存有無・実績    | 出品制限（Selling Limits）の有無で MVP の規模が変わります                                                          |

---

## 14. MVP に含めるもの / 含めないもの

### 14.1 含めるもの

- 2店舗からの商品取得（一覧 + 差分詳細）、共通形式への変換、同期ログ
- PSA10 判定（多要素・確信度付き、曖昧は「要確認」へ）
- 商品名解析（決定的パーサ + 店舗ルール + JSON-LD + AI 補助、三つ組保持）
- 同一商品の自動統合（高確信のみ）+ **手動統合・解除 UI**
- 画像取得・重複排除・`ORIGINAL` 保存、`BLACK_MASK`/`CROP`/`BLUR` の
  **生成と管理画面プレビュー**（本番既定にはしない）、画像確認・手動承認画面
- 実質仕入原価による**推奨仕入れ先の表示**（自動発注はしない）
- 利益計算（全費目・楽観/基準/悲観の3シナリオ・設定スナップショット保存）
- 最低販売価格の逆算
- AI 英語生成（タイトル / 説明 / Item Specifics）+ Zod 検証 + 手動編集
- eBay OAuth、Metadata API 動的取得、Inventory API による
  **Sandbox 出品**と**Production への少数出品（承認後）**
- 価格・在庫の定期同期、eBay 数量更新・出品停止
- 管理画面 6 画面（ダッシュボード / 仕入れ先 / 商品一覧 / 商品詳細 / 画像確認 / 設定）
- **Dry Run 既定 ON**、二段階確認、監査ログ、RLS

### 14.2 含めないもの（Post-MVP）

- 提携先への**自動発注**・自動仕入
- **完全自動出品**（無人での publish）
- 複数マーケットプレイス（US 以外）への同時展開
- 3店舗目の実接続（**受け入れる仕組みは作るが実店舗は追加しない**）
- 送料の配送業者 API によるリアルタイム見積（初期は料金表テーブル）
- 関税の国別完全自動計算（初期は設定 + 手動確認）
- 実売相場の完全自動取得（Marketplace Insights 承認待ち）
- 返品・キャンセルの自動処理、会計連携、多通貨の自動リバランス
- 物体検出モデル（YOLO 等）の学習による高精度スラブ検出
  （初期は幾何 + テンプレート + バーコード + OCR の合議で十分と判断）

---

## 15. 最初に作るファイル一覧（Phase 1）

承認をいただいたら、以下を作成します。

**基盤 (12)**

```
package.json, pnpm-workspace.yaml, turbo.json, tsconfig.base.json
.eslintrc.cjs, .prettierrc, vitest.workspace.ts, .env.example
.gitignore, README.md, .github/workflows/ci.yml, docs/phases/README.md
```

**DB (7)**

```
packages/db/package.json
packages/db/src/schema/suppliers.ts
packages/db/src/schema/catalog.ts
packages/db/src/schema/images.ts
packages/db/src/schema/marketplace.ts
packages/db/src/schema/costs.ts
packages/db/src/schema/ops.ts
supabase/migrations/0001_init.sql
supabase/migrations/0002_rls.sql
```

**コア型と安全装置 (8)**

```
packages/core/src/types/money.ts          # decimal.js ラッパ Money 型
packages/core/src/types/attributed.ts     # {value, source, confidence}
packages/core/src/types/supplier.ts
packages/core/src/types/catalog.ts
packages/core/src/config/settings.ts      # app_settings 読み書き
packages/ebay/src/guard/dry-run-guard.ts  # 本番書き込みを型で封じる
packages/ebay/src/guard/dry-run-guard.test.ts
packages/core/src/types/money.test.ts
```

**Adapter 基盤 (5)**

```
packages/adapters/src/base/supplier-adapter.ts   # インターフェース定義
packages/adapters/src/base/http-client.ts        # UA/間隔/条件付きGET/リトライ
packages/adapters/src/base/rate-limiter.ts
packages/adapters/src/base/snapshot-cache.ts
packages/adapters/src/base/http-client.test.ts
```

**Web (8)**

```
apps/web/package.json, next.config.ts, tailwind.config.ts
apps/web/app/layout.tsx
apps/web/app/(auth)/login/page.tsx
apps/web/app/(admin)/layout.tsx              # 認証ガード
apps/web/app/(admin)/dashboard/page.tsx      # 数値はまだダミー
apps/web/lib/auth/require-admin.ts
```

**調査スクリプト (2)**

```
scripts/research/snapshot.ts
scripts/research/analyze-structure.ts
```

合計 **約 42 ファイル**。Phase 1 完了時点で
「ログインして空のダッシュボードが見える / DB が立っている /
Dry Run ガードのテストが通る」状態になります。

---

## 付録: 出典

- [Condition Descriptor IDs for Trading Cards — eBay Developers](https://developer.ebay.com/api-docs/user-guides/static/mip-user-guide/mip-enum-condition-descriptor-ids-for-trading-cards.html)
- [ConditionDescriptor: eBay Inventory API](https://developer.ebay.com/api-docs/sell/inventory/types/slr:ConditionDescriptor)
- [eBay Connect 2023: Condition Grading — Trading Cards (PDF)](https://developer.ebay.com/cms/files/connect-2023/condition_grading_trading_cards.pdf)
- [createOrReplaceInventoryItem — Inventory API](https://developer.ebay.com/api-docs/sell/inventory/resources/inventory_item/methods/createOrReplaceInventoryItem)
- [API Call Limits — eBay Developers](https://developer.ebay.com/develop/get-started/api-call-limits)
- [getUserRateLimits — Developer Analytics API](https://developer.ebay.com/api-docs/developer/analytics/resources/user_rate_limit/methods/getUserRateLimits)
- [Marketplace Insights API — Overview](https://edp.ebay.com/api-docs/buy/marketplace-insights/static/overview.html)
- [eBay Sold Data API Alternatives Compared (2026)](https://sold-comps.com/alternatives)
- [Adding pictures to your listings — eBay Help](https://www.ebay.com/help/selling/listings/adding-pictures-listings?id=4148)
- [eBay Photo Policy: Watermarks, Text, Logos](https://www.img.vision/handbook/ebay/listing-help/photo-compliance-rules/)
- [eBay Enforces New Picture Requirements — Miva](https://blog.miva.com/ebay-enforces-new-picture-requirements)
- [Authenticity Guarantee for Trading Cards — eBay](https://pages.ebay.com/authenticity-guarantee-tradingcards-seller/)
- [eBay Drops Trading Card Authentication Threshold To $200](https://www.valueaddedresource.net/ebay-trading-card-threshold-packaging-updates/)
- [Your VAT obligations in the UK & EU — eBay](https://www.ebay.com/help/selling/selling/vat-obligations-eu?id=4650)
- [IOSS customs duty integration: 2026 Changes](https://www.crossbordervat.com/ioss-customs-duty-integration-2026-changes/)
- [【2026年最新】eBay輸出でのおすすめ発送方法](https://ebay-marketing-tool.com/shipping-method/)
- [eBay Title Character Limit (2026)](https://ecomli.com/blog/ebay-listing-title-best-practices-2026)
