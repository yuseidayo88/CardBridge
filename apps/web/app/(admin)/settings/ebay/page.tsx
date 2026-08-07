import { REQUIRED_SCOPES } from '@cardbridge/ebay';
import { requireAdmin } from '@/lib/auth/require-admin';
import { readEbayConfig } from '@/lib/ebay/config';
import { getConnectionStatus } from '@/lib/ebay/credentials';
import {
  completeEbayConnectionManually,
  startEbayConnection,
  testApplicationToken,
} from '@/app/actions/ebay';

/**
 * The eBay connection screen.
 *
 * Written to be usable by someone who is midway through the developer signup
 * and does not yet know which of the several things they are missing. It states
 * what is set, what is not, and what each missing piece blocks — rather than
 * offering a Connect button that fails for reasons the page could have named.
 */

export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Record<string, string> = {
  declined: 'eBay の同意画面でキャンセルされました。もう一度お試しください。',
  state: 'セッションの検証に失敗しました。時間切れの可能性があります。最初からやり直してください。',
  scopes:
    '接続はできましたが、必要な権限が付与されていません。キーセットの OAuth Scopes を確認してください。',
  exchange: 'アクセストークンの取得に失敗しました。',
  config: '設定が不足しています。',
  paste: '貼り付けた内容からコードを読み取れませんでした。',
  ebay: 'eBay からエラーが返されました。',
};

function Panel({
  tone,
  title,
  children,
}: {
  tone: 'ok' | 'warn' | 'error' | 'info';
  title: string;
  children?: React.ReactNode;
}) {
  const styles = {
    ok: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100',
    warn: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100',
    error:
      'border-red-300 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100',
    info: 'border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100',
  }[tone];

  return (
    <div className={`rounded-lg border p-4 ${styles}`}>
      <div className="font-semibold">{title}</div>
      {children ? <div className="mt-2 text-sm">{children}</div> : null}
    </div>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-200 py-2 last:border-0 dark:border-slate-700">
      <span className="text-sm text-slate-600 dark:text-slate-400">{label}</span>
      <span className="flex items-center gap-2 font-mono text-sm">
        <span aria-hidden>{ok ? '✓' : '—'}</span>
        <span className={ok ? '' : 'text-slate-400'}>{value}</span>
      </span>
    </div>
  );
}

export default async function EbaySettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();

  const params = await searchParams;
  const first = (key: string): string | null => {
    const value = params[key];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  };

  const config = readEbayConfig();
  const status = await getConnectionStatus(config.environment);

  const error = first('error');
  const detail = first('detail');
  const tested = first('tested');
  const connected = first('connected') === '1';

  const canRunUserFlow = config.missing.length === 0 && Boolean(config.redirectUri);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">eBay 接続</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          環境: <span className="font-mono font-semibold">{config.environment}</span>
        </p>
      </div>

      {connected ? <Panel tone="ok" title="接続が完了しました" /> : null}

      {error ? (
        <Panel tone="error" title={ERROR_MESSAGES[error] ?? 'エラーが発生しました'}>
          {detail ? (
            <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{detail}</pre>
          ) : null}
        </Panel>
      ) : null}

      {tested === 'ok' ? (
        <Panel tone="ok" title="App ID と Cert ID は正常です">
          Application Token を取得できました（有効期間 約
          {Math.round(Number(first('expires') ?? 0) / 60)} 分）。 Metadata API
          の取得はこの時点で動きます。
        </Panel>
      ) : null}
      {tested === 'fail' ? (
        <Panel tone="error" title="Application Token を取得できませんでした">
          {detail ? (
            <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{detail}</pre>
          ) : null}
        </Panel>
      ) : null}

      {/* --- configuration ------------------------------------------------ */}
      <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="mb-3 font-semibold">環境変数</h2>
        <Row label="EBAY_APP_ID" value={config.appId ?? '未設定'} ok={Boolean(config.appId)} />
        <Row
          label="EBAY_CERT_ID"
          value={config.hasCertId ? '設定済み' : '未設定'}
          ok={config.hasCertId}
        />
        <Row
          label="TOKEN_ENCRYPTION_KEY"
          value={config.hasEncryptionKey ? '設定済み' : '未設定'}
          ok={config.hasEncryptionKey}
        />
        <Row
          label="EBAY_REDIRECT_URI (RuName)"
          value={config.redirectUri ?? '未設定'}
          ok={Boolean(config.redirectUri)}
        />

        <p className="mt-3 text-xs text-slate-500">
          Cert ID と暗号化キーは値を表示しません。設定の有無のみを表示します。
        </p>
      </section>

      {/* --- step 1: application token ------------------------------------ */}
      <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="font-semibold">ステップ1: キーの動作確認</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          ユーザー同意なしで取得できる Application Token を試します。RuName
          もテストユーザーも不要です。 ここが通れば、鍵の問題と同意フローの問題を切り分けられます。
        </p>
        <form action={testApplicationToken} className="mt-3">
          <button
            type="submit"
            disabled={!config.appId || !config.hasCertId}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
          >
            Application Token を取得してみる
          </button>
        </form>
      </section>

      {/* --- step 2: user consent ----------------------------------------- */}
      <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="font-semibold">ステップ2: セラーアカウントの接続</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          在庫・出品の操作にはセラー本人の同意が必要です。RuName（<code>EBAY_REDIRECT_URI</code>
          ）が必要になります。
        </p>

        {status.connected ? (
          <div className="mt-3">
            <Panel
              tone={status.needsReauthorization ? 'warn' : 'ok'}
              title={status.needsReauthorization ? '再認可が必要です' : '接続済み'}
            >
              <div className="space-y-1">
                <div>
                  リフレッシュトークン有効期限:{' '}
                  {status.refreshTokenExpiresAt?.toLocaleString('ja-JP') ?? '不明'}
                </div>
                <div>アクセストークン: {status.accessTokenUsable ? '有効' : '要更新'}</div>
                <div className="pt-1 text-xs">付与スコープ {status.scopes.length} 件</div>
              </div>
            </Panel>
          </div>
        ) : (
          <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">未接続です。</p>
        )}

        <form action={startEbayConnection} className="mt-3">
          <button
            type="submit"
            disabled={!canRunUserFlow}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {status.connected ? 'eBay に再接続する' : 'eBay に接続する'}
          </button>
        </form>

        {!canRunUserFlow ? (
          <p className="mt-2 text-xs text-slate-500">
            {config.redirectUri
              ? `未設定: ${config.missing.join(', ')}`
              : 'RuName（EBAY_REDIRECT_URI）が未設定のため実行できません。'}
          </p>
        ) : null}
      </section>

      {/* --- fallback ------------------------------------------------------ */}
      <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="font-semibold">代替手段: コードを手で貼り付ける</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          eBay が <code>http://localhost</code> のリダイレクトURLを受け付けない場合に使います。
          同意後にブラウザのアドレスバーに表示される URL を、<strong>まるごと</strong>
          貼り付けてください。
          <code>code=</code> の部分だけでも構いません。
        </p>
        <form action={completeEbayConnectionManually} className="mt-3 space-y-3">
          <textarea
            name="pastedCode"
            rows={4}
            required
            placeholder="https://example.com/callback?code=v%5E1.1%23i%5E1%23... または code の値そのもの"
            className="w-full rounded border border-slate-300 p-2 font-mono text-xs dark:border-slate-600 dark:bg-slate-800"
          />
          <button
            type="submit"
            disabled={!canRunUserFlow}
            className="rounded border border-slate-300 px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600"
          >
            このコードで接続する
          </button>
        </form>
        <p className="mt-2 text-xs text-slate-500">
          認可コードの有効期間は数分です。期限切れの場合は同意からやり直してください。
        </p>
      </section>

      {/* --- reference ----------------------------------------------------- */}
      <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="mb-2 font-semibold">要求するスコープ</h2>
        <ul className="space-y-1 font-mono text-xs text-slate-600 dark:text-slate-400">
          {REQUIRED_SCOPES.map((scope) => (
            <li key={scope}>{scope.replace('https://api.ebay.com/oauth/api_scope/', '')}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-slate-500">
          Marketplace Insights（販売済み価格）は Limited Release で新規受付が停止しているため、
          意図的に要求していません。
        </p>
      </section>
    </div>
  );
}
