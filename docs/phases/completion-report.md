# 完成報告 — 実装できた範囲と、残っている2つのブロッカー

**351 テスト全通過。** typecheck / lint / format / web build / DB マイグレーション /
ジョブキュー同時実行検証、すべて成功しています。

「完成させてほしい」というご依頼に対し、**2点だけ私の側では埋められません**。
まずそれを明確にし、その後に実装内容を報告します。

---

## 1. 埋められない2点

### 1.1 提携2サイトへのネットワーク到達性

```
www.magicardshop.jp:443      403 (gateway CONNECT rejected)
www.cardrush-pokemon.jp:443  403
```

これは提携先からの許可とは別レイヤの、**このセッションを起動した実行環境の
ネットワークポリシー**です（[docs](https://code.claude.com/docs/en/claude-code-on-the-web)）。
第三者プロキシ経由での迂回はポリシー回避に当たるため行っていません。

**影響**: `supplier_settings.selectors` が空のままです。取得ジョブは
「セレクター未設定」と報告して停止します。

**解消後にすべきこと**（コードは書き終えています）:

```bash
pnpm research:snapshot --all   # 各カテゴリを1回だけ取得
pnpm research:analyze          # 構造診断 → セレクター案を出力
# → 出力レポートをもとに supplier_settings.selectors を設定
```

`GenericCartAdapter` は合成フィクスチャで**23テスト通過済み**です。
実サイトのHTMLが手に入れば、**書くのは設定であってコードではありません**。

### 1.2 eBay Developer 認証情報

申請は**あなたの本人確認と API 利用規約への法的同意**を伴うため、
代行できません。手順は `docs/setup/ebay-developer-application.md`
（Sandbox まで約15分）。

**影響**: OAuth 実行、Metadata API の実データ取得、Sandbox 出品ができません。
クライアント実装は完了しており、**eBay パッケージ全体で59テスト**
（うち Inventory/OAuth/暗号化が28件）が偽の HTTP 層に対して通っています。

---

## 2. 実装した全体像

```
apps/
  web/        Next.js 管理画面（ダッシュボード / 仕入れ先 / 商品一覧 / 商品詳細）
  worker/     常駐ジョブワーカー（キュー・仕入れ同期）
packages/
  core/       ドメイン層（Money / Attributed / 解析 / 統合 / 利益 / 出品判定）
  db/         Drizzle スキーマ 28テーブル + RLS + 制約
  adapters/   Supplier Adapter 基盤 + GenericCartAdapter
  ebay/       Dry Run ガード / OAuth / トークン暗号化 / Inventory API
  ai/         Provider 抽象 / Zod 検証 / 幻覚ガード / プロンプト
  imaging/    スラブ幾何 / マスク安全検証 / sharp パイプライン
```

### 2.1 安全装置（最重要）

本番 eBay への書き込みには**独立した4条件すべて**が必要です。

| #   | 条件                            | 場所                                  |
| --- | ------------------------------- | ------------------------------------- |
| 1   | `DRY_RUN=false`                 | 環境変数（文字列 `false` のときのみ） |
| 2   | `ALLOW_PRODUCTION_PUBLISH=true` | 環境変数                              |
| 3   | 商品・環境スコープの管理者承認  | DB                                    |
| 4   | 実行回数が上限未満              | `MAX_PUBLISH_PER_RUN`                 |

**規約ではなく型で強制**しています。`EbayInventoryClient` の更新系メソッドは
**すべて private な API クロージャ**を持ち、`DryRunGuard.execute()` 経由でしか
ネットワークに到達しません。安全設計を読んでいない人が将来メソッドを追加しても、
**他に経路がないため**承認なしには出品できません。

テストで固定: Dry Run 中に6種類の更新系すべてを呼び、**fetch が一度も
呼ばれないこと**を検証しています。

### 2.2 「推測しない」の実装

| 箇所                 | 実装                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------ |
| タイトル解析         | 発売年・セット名・英語名は**常に `unknown`**。構造化データかカタログ照合のみが埋める |
| PSA10判定            | タイトル単独では CONFIRMED にしない。独立シグナル3つ以上が必要                       |
| 在庫数               | 店舗が公開しなければ**常に1**。複数店舗の在庫を合算しない                            |
| 関税                 | `CARRIER_QUOTE_REQUIRED` / `MANUAL_REVIEW` では**金額を作らない**                    |
| AI出力               | **幻覚ガード**が出力中の数値・年を入力テキストと照合。存在しなければ BLOCKING        |
| Condition Descriptor | ID を一切ハードコードせず、キャッシュ済みポリシーから解決                            |
| 画像マスク           | 検出信頼度が低い / カード本体に重なる → **ピクセルに触れず**手動確認へ               |

### 2.3 AI 層（Phase 6）

**AI の裁量を構造的に狭めています。** タイトルは書かせません
（`title-builder` が構造化フィールドから決定的に組み立てる）。
AI の担当は英語カード名・説明文・Item Specifics の3つだけです。

- **プロンプトインジェクション対策**: 指示は `system`、店舗テキストは `user`。
  テストで「店舗テキストが指示チャネルに混入しないこと」を固定
- **幻覚ガード**: 出力の全フィールドを走査し、入力に存在しない数値・年を検出。
  年は特に厳格（もっともらしい誤った年はレビュアーの目に正しく見えるため）
- **Item Specifics のフィルタ**: カテゴリが提供しない aspect 名は破棄し、
  eBay 側の綴りに正規化
- **失敗も記録**: スキーマ違反もプロバイダ障害も例外ではなく結果として返し、
  `ai_generations` に残す

### 2.4 画像処理（Phase 4）

幾何計算とマスク判定は**純粋関数**で、sharp なしで完全にテストできます。
sharp は最後のピクセル操作でのみ遅延ロードします。

**多段合議**: テンプレート座標 / バーコード検出 / OCR を独立検出器として扱い、
**異なる検出器同士が一致したときのみ**信頼度を上げます
（同じ OCR の2回読みは裏付けになりません）。

**安全検証**（1つでも失敗したら手動確認へ、ピクセルには触れない）:
カード本体との重なり / 面積上限8% / 検出信頼度 / スラブのアスペクト比 /
画像境界の逸脱。

**本番既定は `ORIGINAL`**。加工版は生成できても
`status: NEEDS_REVIEW` を返し、DB の CHECK 制約も人手承認を要求します。

### 2.5 ジョブキュー（Phase 2/8）

Postgres をキューとして使用（Redis を足さない理由: 操作対象の行との
トランザクション整合が元々必要で、`SKIP LOCKED` で十分だからです）。

**実 Postgres に対して検証済み**（`scripts/db/verify-queue.sh`）:

```
ok: the second enqueue of the same work was rejected
ok: worker-a claimed <id> while holding the row; worker-b skipped it
ok: the same lock key is reusable after completion
ok: 1 job(s) reclaimed from the dead worker
ok: the running job was not disturbed
```

2番目は**実際に並行するトランザクション**で検証しています
（逐次実行では SKIP LOCKED を何も証明しないため）。

---

## 3. テスト結果 — 351件

| テストファイル                                             |    件数 |
| ---------------------------------------------------------- | ------: |
| `eligibility.test.ts`（出品判定）                          |      26 |
| `cost-model.test.ts`（利益計算・逆算）                     |      26 |
| `geometry.test.ts`（画像幾何・マスク安全検証）             |      27 |
| `hallucination-guard.test.ts`（AI検証・幻覚ガード）        |      30 |
| `inventory-client.test.ts`（Inventory API・OAuth・暗号化） |      28 |
| `title-parser.test.ts`（正規化・タイトル解析）             |      23 |
| `generic-cart-adapter.test.ts`                             |      23 |
| `money.test.ts`                                            |      22 |
| `title-builder.test.ts`（SKU・タイトル生成）               |      21 |
| `http-client.test.ts`（HTTP・URL安全性）                   |      21 |
| `sourcing-selector.test.ts`（仕入れ先選択）                |      20 |
| `psa-detector.test.ts`（PSA10判定）                        |      19 |
| `scoring.test.ts`（同一商品統合）                          |      18 |
| `dry-run-guard.test.ts`                                    |      17 |
| `pipeline.test.ts`（画像パイプライン）                     |      16 |
| `condition-descriptors.test.ts`                            |      14 |
| **合計**                                                   | **351** |

```bash
pnpm test                        # 351 passed
pnpm typecheck                   # 0 errors
pnpm lint                        # clean
pnpm format:check                # clean
pnpm --filter @cardbridge/web build
scripts/db/verify-migrations.sh  # 28テーブル + 7制約
scripts/db/verify-queue.sh       # 同時実行5項目
```

---

## 4. テストが見つけた実バグ（累計6件）

前回報告の4件に加えて2件。

### 4.1 `EbayEnvironment` の二重定義

`oauth.ts` と `dry-run-guard.ts` が同じ union を別々に宣言していました。
**必ず一致していなければならないが別々に宣言されている2つの enum は、
いずれ食い違います。** ガードを唯一の定義元にしました。

### 4.2 `MinPriceInput` の安全シナリオ降格（前回報告）

再掲しますが、これが最も危険でした。`ProfitInput` をスプレッドすると
悲観シナリオの既定が静かに上書きされ、**円が動いた瞬間に赤字になる価格を
もっともらしい顔で返していました**。

---

## 5. 未実装（認証情報・到達性が前提のもの）

| 項目                          | 状態                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------- |
| magi / カードラッシュの実接続 | セレクター待ち。アダプターは完成                                              |
| eBay Metadata API 実取得      | 認証情報待ち。解決ロジックは完成・テスト済み                                  |
| Sandbox 出品                  | 同上                                                                          |
| AI プロバイダの実接続         | `AiProvider` 実装クラス（Anthropic/OpenAI）が未作成。抽象と検証チェーンは完成 |
| 画像の実取得・保存            | Supabase Storage 連携が未実装。処理パイプラインは完成                         |
| 相場データ取得                | Browse API クライアント未実装（Marketplace Insights は利用不可）              |
| 画像確認画面・コスト設定画面  | プレースホルダのまま                                                          |
| 商品統合画面                  | プレースホルダのまま（スコアリングは完成・18テスト）                          |

ワーカーは未実装のジョブ種別を**明示的にエラーにします**。
ダッシュボード上で成功に見える無言の no-op より、失敗として見えるほうが安全です。

---

## 6. 次に必要なこと（優先順）

1. **eBay Developer 申請の手順1〜5**（約15分）→ Phase 7 が動きます
2. **エグレス許可リストへの2ドメイン追加**、または HTMLスナップショットの共有
   → Phase 2 が動きます
3. **Anthropic API キー** → AI 層が動きます（抽象は完成しているので
   Provider 実装1ファイルで接続できます）
4. 実セラーアカウントの手数料率 → コストプロファイルのプレースホルダを置換

1と2が揃えば、**Sandbox で1商品を出品するところまで到達できます**。
