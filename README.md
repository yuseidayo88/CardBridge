# CardBridge

日本国内の提携カードショップから PSA10 ポケモンカードを取得し、
共通形式への正規化・利益判定・AI 英語生成を経て、
**管理者の承認後にのみ** eBay へ出品・同期する半自動管理システム。

> **現在 Phase 1 / 3 / 5（基盤・解析・統合・利益計算）完了。** eBay への書き込みは一切行われません。
> `DRY_RUN` は既定で有効です。

---

## 安全装置

本番 eBay へ書き込むには、**独立した4条件すべて**を満たす必要があります。

| #   | 条件                            | 場所                                          |
| --- | ------------------------------- | --------------------------------------------- |
| 1   | `DRY_RUN=false`                 | 環境変数（明示的に文字列 `false` のときのみ） |
| 2   | `ALLOW_PRODUCTION_PUBLISH=true` | 環境変数                                      |
| 3   | 対象商品への管理者承認          | DB（承認時の環境とペイロードハッシュを記録）  |
| 4   | 実行回数が上限未満              | `MAX_PUBLISH_PER_RUN`（既定 5）               |

これは規約ではなく**型で強制**されています。eBay の更新系操作は
`DryRunGuard.execute()` を通してのみ到達可能で、その引数
`PublishAuthorization` はモジュール外から生成できません
（ブランド用の Symbol が非公開）。
条件を満たさない場合、API 呼び出し関数は**実行されず**、
「送信されるはずだったペイロード」が記録されるだけです。

```
packages/ebay/src/guard/dry-run-guard.ts       実装
packages/ebay/src/guard/dry-run-guard.test.ts  20 件のテスト
```

---

## セットアップ

```bash
pnpm install
cp .env.example .env.local     # 値を記入
```

Supabase プロジェクトに対して:

```bash
psql "$SUPABASE_DB_URL" -f supabase/migrations/0000_init.sql
psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_rls.sql
psql "$SUPABASE_DB_URL" -f supabase/migrations/0002_seed.sql
```

管理者を登録（Supabase Auth でユーザー作成後、その UUID を使用）:

```sql
INSERT INTO admin_users (id, email) VALUES ('<auth.users の uuid>', 'you@example.com');
```

起動:

```bash
pnpm dev          # http://localhost:3000
```

---

## 検証コマンド

```bash
pnpm test                          # 351 tests
pnpm typecheck                     # 全パッケージ
pnpm lint
pnpm format:check
pnpm --filter @cardbridge/web build
scripts/db/verify-migrations.sh    # 使い捨て Postgres へ全マイグレーション適用 + 制約検証
```

`verify-migrations.sh` はネットワークも Supabase も不要です。

---

## 構成

```
apps/web              Next.js 15 App Router（管理画面）
packages/core         ドメイン層。Money / Attributed / 型 / 設定
packages/db           Drizzle スキーマ（28 テーブル）
packages/ebay         eBay 連携。現時点では DryRunGuard のみ
packages/adapters     Supplier Adapter 基盤（HTTP・レート制限・URL 安全性・設定スキーマ）
scripts/research      対象サイトの構造調査ツール
scripts/db            マイグレーション検証
supabase/migrations   SQL（Drizzle 生成 + 手書きの RLS / 制約 / シード）
docs/design           設計提案書
docs/phases           フェーズ完了報告
```

### 設計上の要点

**金額に `number` を使わない。** `Money`（decimal.js ラッパ）のみ。
異なる通貨の演算は実行時に例外。ESLint が利益計算コードでの生の算術演算を
機械的に禁止します。

**推測値と確定値を分離する。** すべての解析属性は
`{ value, source, confidence }` を持ちます。`source: 'unknown'` なら
`value` は必ず `null`。この不変条件は DB の CHECK 制約でも担保されています。

**店舗固有の知識をドメイン層に漏らさない。** セレクター・ページ送り・
在庫判定は `supplier_settings.selectors` (JSONB) に外部化。
HTML 構造が変わったら**その行を直すだけ**で、再デプロイは不要です。

**画像は既定で無加工。** eBay のピクチャーポリシーは商品を覆う
オーバーレイを禁じ、グレード品には鑑定会社の表示を求めます。
認証番号の黒塗りはその中間の未検証領域にあるため、
既定を `ORIGINAL` とし、加工は 1 件ずつの手動承認を必須にしています。
詳細と根拠は `docs/design/00-proposal.md` §4。

---

## 対象サイトへの配慮

提携許可を得ていますが、許可は「負荷をかけてよい」という意味ではありません。

| 項目           | 既定                                                   |
| -------------- | ------------------------------------------------------ |
| 同時実行       | 1（店舗ごと）                                          |
| リクエスト間隔 | 3 秒 + ジッター                                        |
| 条件付き GET   | ETag / Last-Modified、304 は即スキップ                 |
| 画像           | SHA-256 で重複排除、同一画像は再取得しない             |
| リトライ       | 最大 3 回、フルジッター指数バックオフ、5xx と 429 のみ |
| User-Agent     | 連絡先 URL 入り。偽装しない                            |
| 接続先         | 提携先ドメインの許可リストのみ（SSRF 対策）            |

---

## 次のフェーズ

Phase 2（Supplier Adapter 実装）は、対象2サイトへの
ネットワーク到達性が前提です。現在の実行環境では
エグレスポリシーによりブロックされています。

到達可能になったら:

```bash
pnpm research:snapshot --all      # 各カテゴリを 1 回だけ取得して保存
pnpm research:analyze             # 構造を診断してセレクター案を出力
```

出力されたレポートをもとに `supplier_settings.selectors` を確定します。
詳細は `docs/phases/phase-1.md`。
