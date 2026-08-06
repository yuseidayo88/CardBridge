import { requestMagicLink } from '@/app/actions/auth';

/**
 * A plain server-action form: no client JavaScript, so no token ever reaches
 * the browser bundle. Next.js server actions carry their own CSRF protection
 * via the action ID and an origin check.
 */
export function LoginForm() {
  return (
    <form action={requestMagicLink} className="flex flex-col gap-3">
      <label htmlFor="email" className="text-sm font-medium">
        メールアドレス
      </label>
      <input
        id="email"
        name="email"
        type="email"
        required
        autoComplete="email"
        maxLength={254}
        placeholder="admin@example.com"
        className="rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800"
      />
      <button
        type="submit"
        className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900"
      >
        ログインリンクを送信
      </button>
      <p className="text-xs text-slate-500">登録済みの管理者にのみリンクが送信されます。</p>
    </form>
  );
}
