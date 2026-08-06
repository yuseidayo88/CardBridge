# eBay Developer 申請手順

> **この作業は代行できません。** 理由は2つです。
>
> 1. `developer.ebay.com` はこの実行環境のエグレスポリシーによりブロックされています
> 2. より本質的に、申請は**本人確認と API 利用規約への法的同意**を伴います。
>    あなたの身元で規約に同意する行為は、私が代理で行うべきものではありません
>
> 代わりに、迷わず進められる手順書としてまとめました。
> 所要時間の目安は **Sandbox まで約15分**、Production 承認は eBay 側の審査待ちです。

---

## 全体の流れ

```
1. eBay 通常アカウント          ← すでにお持ちなら不要
2. Developer Program 登録        → Sandbox キーセット即時発行
3. Sandbox テストユーザー作成
4. RuName（OAuth リダイレクト）設定
5. .env.local へ記入 → Phase 7 へ
--- ここまで即日。以下は審査あり ---
6. Production キーセット申請
7. Business Policies 有効化
8. （必要なら）Application Growth Check
```

**先に着手をおすすめするもの**: 6 と 7 は承認に時間がかかります。
Sandbox 開発と並行して早めに出しておくのが安全です。

---

## 1. Developer Program 登録

<https://developer.ebay.com/> → 右上 **Register**

| 入力項目               | 入れるもの                                 |
| ---------------------- | ------------------------------------------ |
| Account type           | 個人事業なら Individual、法人なら Company  |
| Email                  | 受信できるアドレス（確認メールが届きます） |
| Developer Account Name | 任意。例 `cardbridge`                      |

登録後、**API License Agreement** への同意を求められます。
ここがまさに私が代行できない箇所です。内容をご確認のうえ同意してください。

---

## 2. キーセットの発行

**Hi <name>! → Application Keysets**

Sandbox は登録直後に自動発行されます。次の3つを控えてください。

| 表示名                  | `.env.local` の変数 |
| ----------------------- | ------------------- |
| App ID (Client ID)      | `EBAY_APP_ID`       |
| Dev ID                  | `EBAY_DEV_ID`       |
| Cert ID (Client Secret) | `EBAY_CERT_ID`      |

> **Cert ID は再表示されません。** 発行時に控えてください。
> パスワードマネージャへ。Slack やメールに貼らないでください。

Production キーセットは同じ画面から申請します（→ 手順6）。

---

## 3. Sandbox テストユーザーの作成

**Sandbox → Test Users → Create Test User**

Sandbox は本番と完全に別世界で、本番アカウントではログインできません。
出品テストにはテストユーザーが必要です。

- **Seller** を1つ作成（出品側）
- Buyer は MVP では不要

生成されたユーザー名とパスワードを控えてください。手順4の OAuth 同意画面で使います。

---

## 4. RuName（OAuth リダイレクト URI）の設定

**Application Keysets → 対象キーセットの「User Tokens」→ Get a Token from eBay via Your Application**

eBay の OAuth はリダイレクト先を URL ではなく **RuName** という別名で管理します。

| 入力項目                | 値                                                   |
| ----------------------- | ---------------------------------------------------- |
| Display Title           | `CardBridge`                                         |
| Your auth accepted URL  | `http://localhost:3000/api/ebay/callback`            |
| Your auth declined URL  | `http://localhost:3000/api/ebay/callback?declined=1` |
| Your privacy policy URL | 公開ページがあればその URL                           |

保存すると `Yourname-Appname-SBX-xxxxxxxxx-xxxxxxxx` 形式の RuName が発行されます。
これを `EBAY_REDIRECT_URI` に入れてください（**URL ではなく RuName 文字列**です）。

本番デプロイ後は、本番ドメインの accepted URL で**別の RuName** を作り直します。

---

## 5. 必要な OAuth スコープ

Phase 7 の実装で要求するスコープです。同意画面で以下が表示されます。

```
https://api.ebay.com/oauth/api_scope/sell.inventory          在庫・オファー・出品
https://api.ebay.com/oauth/api_scope/sell.inventory.readonly
https://api.ebay.com/oauth/api_scope/sell.account            ビジネスポリシー・ロケーション
https://api.ebay.com/oauth/api_scope/sell.account.readonly
https://api.ebay.com/oauth/api_scope/commerce.identity.readonly
```

Metadata API（カテゴリ・Condition Descriptor・Item Specifics の取得）は
**Application Token** で叩けるため、ユーザー同意は不要です。

> Marketplace Insights（販売済み価格）のスコープは**あえて要求しません**。
> Limited Release で新規受付が停止しているためです。詳細は
> `docs/design/00-proposal.md` §3.1。

---

## 6. Production キーセットの申請

**Application Keysets → Production の「Request」**

審査があります。用途説明を求められるので、以下をベースにしてください
（そのまま貼らず、実態に合わせて調整してください）。

> We operate a cross-border retail business that sources graded Pokémon
> trading cards from licensed Japanese partner retailers and lists them on
> eBay. The application uses the Inventory API to create and manage listings,
> the Account API to reference our business policies and inventory location,
> and the Metadata API to retrieve category-specific item aspects and
> condition descriptors. All listings are reviewed and approved by a human
> operator before publication. We do not perform bulk automated listing.

最後の2文が効きます。半自動であることは審査上の減点ではなく、加点材料です。

---

## 7. Business Policies の有効化

**必須です。** Inventory API の `createOffer` は
Fulfillment / Payment / Return の各ポリシー ID を要求します。

有効化: eBay セラーアカウント → **Account settings → Business policies → Opt in**

有効化後、各ポリシーを1つずつ作成し、ID を控えてください。

| ポリシー            | `.env.local`                 |
| ------------------- | ---------------------------- |
| Fulfillment（配送） | `EBAY_FULFILLMENT_POLICY_ID` |
| Payment（支払い）   | `EBAY_PAYMENT_POLICY_ID`     |
| Return（返品）      | `EBAY_RETURN_POLICY_ID`      |

ID は UI からも読めますが、Phase 7 では Account API の
`getFulfillmentPolicies` 等で**取得して一覧表示する画面**を作ります。
手打ちによる転記ミスを避けるためです。

さらに **Inventory Location** を1つ作成し、そのキーを
`EBAY_MERCHANT_LOCATION_KEY` に入れてください（発送元の日本の住所）。

---

## 8. Application Growth Check（当面不要）

既定のコール上限は概ね 1日 25,000 コール（API により異なります）。
MVP の規模では十分です。

自分のアプリの実際の上限は Developer Analytics API の
`getUserRateLimits` で取得できます。Phase 7 では**この実測値をもとに**
レート制御します（固定値をコードに書きません）。

上限に近づいたら Growth Check を申請してください。

---

## 記入後の `.env.local`

```bash
EBAY_ENV=SANDBOX                  # ← Production へ切り替えるのは Phase 9
EBAY_APP_ID=YourApp-cardbrid-SBX-xxxxxxxxx-xxxxxxxx
EBAY_CERT_ID=SBX-xxxxxxxxxxxx-xxxx-xxxx-xxxx-xxxx
EBAY_DEV_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
EBAY_REDIRECT_URI=Yourname-Appname-SBX-xxxxxxxxx-xxxxxxxx
EBAY_MARKETPLACE_ID=EBAY_US
EBAY_FULFILLMENT_POLICY_ID=
EBAY_PAYMENT_POLICY_ID=
EBAY_RETURN_POLICY_ID=
EBAY_MERCHANT_LOCATION_KEY=cardbridge-jp-01

# 安全装置はこのまま触らないでください
DRY_RUN=true
ALLOW_PRODUCTION_PUBLISH=false
```

Sandbox キーであっても、`EBAY_ENV=SANDBOX` のままにしてください。
`DryRunGuard` は Sandbox 承認で Production 出品を authorize しません
（`packages/ebay/src/guard/dry-run-guard.ts`）。

---

## 完了チェックリスト

- [ ] Developer Program 登録、API License Agreement 同意
- [ ] Sandbox キーセット3点を控えた
- [ ] Sandbox テストユーザー（Seller）を作成した
- [ ] RuName を発行し `EBAY_REDIRECT_URI` に記入した
- [ ] `.env.local` に App ID / Cert ID / Dev ID を記入した
- [ ] Production キーセットを**申請済み**（承認待ちで可）
- [ ] Business Policies を **Opt in** した
- [ ] Fulfillment / Payment / Return を各1つ作成した
- [ ] Inventory Location を作成した

上の**5項目目まで**が終われば、Phase 7（OAuth + Inventory API + Sandbox 出品）に
着手できます。Production 承認と Business Policies は Phase 9 までに揃えば十分です。

---

## セキュリティ上の注意

- **Cert ID を GitHub に置かないでください。** `.env.local` は `.gitignore` 済みです
- キーを Slack・メール・チャットに貼らないでください。漏洩した場合は
  Application Keysets 画面から即座に regenerate してください
- OAuth の refresh token は DB に **AES-256-GCM で暗号化**して保存します
  （鍵は `TOKEN_ENCRYPTION_KEY`、DB には保存しません）。生成:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

---

## 参考

- [eBay Developers Program](https://developer.ebay.com/)
- [Inventory API — createOrReplaceInventoryItem](https://developer.ebay.com/api-docs/sell/inventory/resources/inventory_item/methods/createOrReplaceInventoryItem)
- [Condition Descriptor IDs for Trading Cards](https://developer.ebay.com/api-docs/user-guides/static/mip-user-guide/mip-enum-condition-descriptor-ids-for-trading-cards.html)
- [API Call Limits](https://developer.ebay.com/develop/get-started/api-call-limits)
- [getUserRateLimits](https://developer.ebay.com/api-docs/developer/analytics/resources/user_rate_limit/methods/getUserRateLimits)

> 本書の手順は eBay の公開ドキュメントと一般に知られた申請フローに基づいています。
> ただし `developer.ebay.com` へ本セッションから到達できないため、
> **画面の文言やメニュー位置が最新版と異なる可能性があります。**
> 相違があればお知らせください。手順書を更新します。
