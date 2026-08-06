# Phase 1 完了報告 — 基盤

## 1. 実装した内容

### 1.1 安全装置（本フェーズの中核）

`DryRunGuard` を実装しました。要件「管理者の明示的な承認なしに本番 eBay へ
出品・変更・終了を行わない」を、**規約ではなく型で強制**しています。

- eBay の更新系操作は `DryRunGuard.execute()` からのみ到達可能
- `execute()` は `PublishAuthorization` を要求する
- `PublishAuthorization` はモジュール外から生成不可（ブランド Symbol が非公開）
- 発行元 `authorizePublish()` は4条件すべてを検証し、1つでも欠ければ throw
- 条件を満たさない場合、**API 呼び出し関数は実行されない**（記録のみ）

4条件は互いに独立です。DB の設定行だけが書き換わっても、環境変数側が
同意しない限り本番書き込みは起きません（`loadSettings()` が安全側に合議）。

### 1.2 Money 型

金額に JS の `number` を使わない要件を実装。decimal.js ラッパで、

- 異なる通貨の演算は `CurrencyMismatchError`
- 為替換算はレート明示必須（暗黙のレート参照を作らない）
- JPY は 0 桁、他は 2 桁として通貨別に丸め
- `fromNumber` は指数表記・非有限値を拒否（精度喪失を境界で検出）
- ESLint が `packages/core/src/profit/**` と `pricing/**` での
  生の算術演算・`Math.*`・`parseFloat` を機械的に禁止

### 1.3 Attributed 型（推測と確定の分離）

すべての解析属性が `{ value, source, confidence }` を保持します。
`source` は信頼度順のランキングで、`preferHigherTrust()` が
「AI に、パーサが確定した値を上書きさせない」を実装します。

不変条件2つを Zod と **DB の CHECK 制約の両方**で担保:

- `source: 'unknown'` なら `value` は必ず `null`
- `value` が `null` なら `confidence` は必ず 0

### 1.4 データベース（28 テーブル）

要件どおり、仕入れ先固有 / 共通カタログ / eBay 出品を分離しました。
巨大な `products` テーブルは存在しません。

主要な整合性保証（アプリではなく DB が担保）:

| 保証                                                 | 実装                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| 同一作業の重複ジョブ不可                             | `sync_jobs.lock_key` の部分ユニーク索引（非終了状態のみ）             |
| 重複出品不可                                         | `(marketplace, environment, sku)` ユニーク + 稼働中出品の部分ユニーク |
| 1 supplier_product は 1 catalog_product にのみ紐付く | 部分ユニーク索引（未解除のもののみ）                                  |
| eBay タイトル 80 文字上限                            | CHECK 制約                                                            |
| 加工画像は人手承認なしに APPROVED 不可               | CHECK 制約                                                            |
| 負の価格・負の在庫・負の数量 不可                    | CHECK 制約                                                            |
| 全テーブル RLS 有効 + anon/authenticated の権限剥奪  | `0001_rls.sql`                                                        |

### 1.5 Supplier Adapter 基盤

店舗固有の知識をドメイン層から隔離する土台。

- `HttpClient` — 唯一の外向き通信経路。ペース制御・条件付き GET・
  リトライ予算・許可リスト・レスポンスサイズ上限を一箇所で強制
- `url-safety` — SSRF 対策（メタデータ endpoint、プライベート IP、
  認証情報埋め込み、非 HTTPS、類似ドメインをすべて拒否）と URL 正規化
- `RateLimiter` — ホスト単位の直列化。バースト不可（トークンバケットではない）
- `supplier-config` — セレクター・ページ送り・在庫判定・商品 ID 抽出戦略の
  Zod スキーマ。HTML 構造変更時は **DB の 1 行を直すだけ**

`SupplierAdapter` インターフェースは提案時から3点変更しています
（`AsyncIterable` 化 / バッチ化 / `capabilities`・`healthCheck` 追加）。
理由は `docs/design/00-proposal.md` §6.2。

### 1.6 管理画面

Next.js 15 App Router。ログイン（マジックリンク）、認証ガード、
ダッシュボード（実データ集計）、残り6画面はフェーズ明記のプレースホルダ。

- `requireAdmin()` が Supabase 認証と `admin_users` の**2段階**で検証
- `import 'server-only'` によりクライアント側への流出をビルドエラー化
- 未設定時は「全員が非管理者」に倒れる（fail-closed）
- Dry Run バナーが全画面に常時表示。本番書き込み可能時は赤く警告

### 1.7 調査ツール

対象サイトへ到達できないため、**調査手順そのものをコード化**しました。

- `scripts/research/snapshot.ts` — 1 URL につき 1 回だけ取得して保存
- `scripts/research/analyze-structure.ts` — 保存済み HTML から
  JS 描画依存度・JSON-LD・商品カード selector・商品 ID パターン・
  在庫語彙・ページ送り形式を診断し、Markdown レポートを生成

合成フィクスチャで動作確認済み（下記「動作確認結果」参照）。

---

## 2. 変更ファイル

新規 62 ファイル。主要なもの:

```
安全装置
  packages/ebay/src/guard/dry-run-guard.ts
  packages/ebay/src/guard/dry-run-guard.test.ts

ドメイン型
  packages/core/src/types/money.ts / money.test.ts
  packages/core/src/types/attributed.ts
  packages/core/src/types/supplier.ts
  packages/core/src/types/catalog.ts
  packages/core/src/config/settings.ts

DB
  packages/db/src/schema/{enums,suppliers,catalog,images,marketplace,costs,ops}.ts
  packages/db/src/index.ts
  supabase/migrations/0000_init.sql      (drizzle-kit 生成)
  supabase/migrations/0001_rls.sql       (手書き: RLS・部分索引・CHECK 制約)
  supabase/migrations/0002_seed.sql      (手書き: 提携先・設定・関税ルール)

Adapter 基盤
  packages/adapters/src/base/{http-client,rate-limiter,url-safety,supplier-config}.ts
  packages/adapters/src/base/http-client.test.ts

管理画面
  apps/web/app/(admin)/layout.tsx, dashboard/page.tsx, ほか6画面
  apps/web/app/(auth)/login/page.tsx
  apps/web/app/auth/callback/route.ts
  apps/web/app/actions/auth.ts
  apps/web/lib/auth/{require-admin,supabase-server}.ts
  apps/web/lib/settings.ts
  apps/web/middleware.ts
  apps/web/components/{dry-run-banner,stat-card,login-form,phase-placeholder}.tsx

ツール・設定
  scripts/research/{snapshot,analyze-structure}.ts
  scripts/db/verify-migrations.sh
  eslint.config.js（金額演算禁止ルールを含む）
  .github/workflows/ci.yml
  README.md, .env.example
```

---

## 3. 動作確認手順

```bash
pnpm install
pnpm test                          # 60 tests
pnpm typecheck
pnpm lint
pnpm format:check
pnpm --filter @cardbridge/web build
scripts/db/verify-migrations.sh    # Postgres 16 が必要。ネットワーク不要
npx tsx scripts/research/analyze-structure.ts docs/research/fixtures/sample-listing.html
```

管理画面を実際に動かす場合:

```bash
# 使い捨て Postgres にマイグレーションを適用したうえで
SUPABASE_DB_URL=postgresql://... DRY_RUN=true EBAY_ENV=SANDBOX \
  pnpm --filter @cardbridge/web dev
```

---

## 4. テスト結果

### 4.1 自動テスト — 60 件すべて成功

```
 Test Files  3 passed (3)
      Tests  60 passed (60)
```

| 対象                         | 件数 | 主な内容                                                                                                                                                                    |
| ---------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dry-run-guard`              | 20   | Dry Run 中に本番 API 関数が**呼ばれない**こと、承認の偽造不可、Sandbox 承認で Production 出品不可、実行回数上限、ブロック理由の説明                                         |
| `money`                      | 19   | 0.1+0.2 問題、100 回減算の累積誤差なし、通貨混在の拒否、レート明示、JPY 0 桁、不正入力の拒否、丸めモード                                                                    |
| `http-client` / `url-safety` | 21   | メタデータ endpoint・プライベート IP・類似ドメインの拒否、URL 正規化の収束、条件付き GET、304 でボディなし、429 の Retry-After 尊重、404 は再試行しない、ホスト単位の直列化 |

### 4.2 マイグレーション検証 — 成功

使い捨て Postgres 16 に全マイグレーションを適用:

```
28 tables, 28 with RLS enabled
ok: dry run on, production publish off, quantity capped at 1, images unmodified
ok: negative price rejected
ok: attribute with source=unknown carrying a value rejected
ok: null attribute with non-zero confidence rejected
ok: eBay title longer than 80 characters rejected
ok: redacted image approved without a human rejected
ok: negative listing quantity rejected
ok: duplicate active sync job rejected
All migration checks passed.
```

### 4.3 管理画面 — HTTP で実確認

実 Postgres に接続した状態で `next start` し、curl で確認:

```
/            307 -> /dashboard
/dashboard   307 -> /login        (未認証)
/suppliers   307 -> /login        (レイアウトのガードが機能)
/login       200  「CardBridge 管理者のみ利用できます メールアドレス
                   ログインリンクを送信 登録済みの管理者にのみリンクが送信されます。」
セキュリティヘッダ  X-Frame-Options / X-Content-Type-Options /
                   Referrer-Policy / Permissions-Policy / HSTS すべて付与
```

ダッシュボードの集計 SQL は実スキーマに対して実行し、
12 指標すべてが 0 を返すことを確認（Phase 1 では正常な状態）。

### 4.4 調査ツール — 合成フィクスチャで確認

`docs/research/fixtures/sample-listing.html`（実サイトの複製ではありません）に対し、
以下をすべて markup のみから正しく導出:

- サーバーレンダリング済み → **Playwright 不要**と判定
- JSON-LD `ItemList` を検出 → 構造化データ優先を推奨
- 商品カード `.product-item`（5 件、全件に価格・リンク・画像）
- 商品 ID が URL パスの数値である可能性を検出
- 在庫語彙 4 種と明示的な個数表記 → `hasExactStockCount = true` を推奨
- ページ送り `?page=N` → 正規 URL から `page` を除外すべきと明記

---

## 5. 未解決事項

### 5.1 ブロッカー — Phase 2 の前提

**対象2サイトへのネットワーク到達性がありません。**

```
www.magicardshop.jp:443      403 (gateway CONNECT rejected)
www.cardrush-pokemon.jp:443  403 (gateway CONNECT rejected)
developer.ebay.com:443       403
```

これは提携先の許可とは別レイヤの、**実行環境のネットワークポリシー**です。
セッション開始時の環境設定に由来し、こちらからは変更できません。
迂回（第三者プロキシ経由の取得など）はポリシー回避に当たるため行っていません。

そのため以下は**未確定のまま**です:

- 両サイトの実際の HTML 構造・CSS セレクター
- 商品詳細 URL の形式と商品 ID の在り処
- JSON-LD の有無 → 抽出戦略の確定
- JS 描画の要否 → Playwright 要否の確定
- 在庫表示の実際の文言と個数取得可否
- ETag / Last-Modified の有無 → 条件付き GET の有効性
- 「両サイトが同一 EC 基盤か」という仮説（`/product-group/{id}` の一致から推測）

`supplier_settings.selectors` は**意図的に空で投入**しています。
もっともらしいセレクターを推測して入れると、
「動かない理由が分かりにくい壊れ方」になるためです。
未設定時は同期ジョブが「セレクター未設定」と報告して停止します。

### 5.2 eBay 仕様のうち Sandbox 実測が必要なもの

- 日本語ポケカの正確なカテゴリ ID（`getCategorySuggestions`）
- PSA の grader value ID / grade 10 の value ID（`getItemConditionPolicies`）
- 必須 Item Specifics 一覧（`getItemAspectsForCategory`）
- 実レート制限（`getUserRateLimits`）

いずれも**ハードコードしません**。Metadata API から取得して
`ebay_condition_policies` / `ebay_aspect_policies` にキャッシュします。

### 5.3 画像ポリシーの書面確認

`ebay.com` のピクチャーポリシー原文に到達できていません。
黒塗りの可否は eBay Japan への照会が必要です。
それまで既定は `ORIGINAL`、加工方式は 1 件ずつの手動承認必須のままとします。

提携先からの**非表示処理済み画像の提供**（`SOURCE_REDACTED`）が
最もリスクの低い解であり、交渉のご了承をいただいています。
実現すればこの論点は消えます。

### 5.4 未投入の実データ

- コストプロファイルの手数料率は**プレースホルダ**（`UNVERIFIED` と明記）。
  実際のセラーアカウントの料率に置き換えが必要
- 米国の関税は `CARRIER_QUOTE_REQUIRED`。
  2025-08-29 の de minimis 撤廃により、低額でも関税が発生しうるため、
  レートを推測せず手動確認へ回す設計にしています
- 国内送料・発送目安は 0 / 3日 の仮値

---

## 6. 次フェーズ（Phase 2）の内容

**前提**: 対象2サイトへの到達性、または HTML スナップショットの提供。

1. `pnpm research:snapshot --all` で各カテゴリを 1 回取得
2. `pnpm research:analyze` で構造レポートを生成
3. レポートをもとに `supplier_settings.selectors` を確定
4. `GenericCartAdapter` を実装（両サイトが同一基盤なら設定差分のみで両対応）
5. `MagiSupplierAdapter` / `CardRushSupplierAdapter` を確定
6. 共通形式への変換と `supplier_products` への保存
7. ジョブキュー worker（`SELECT ... FOR UPDATE SKIP LOCKED`）
8. 同期ログ・アダプター健全性チェック
9. 仕入れ先管理画面の実装

到達性が得られない場合は、Phase 2 の 4〜6 を保留したまま
Phase 5'（eBay Metadata API 先行接続）へ進むことも可能です。
そちらはサイト構造に依存しません。
