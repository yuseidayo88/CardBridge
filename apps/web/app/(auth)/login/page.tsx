import { redirect } from 'next/navigation';
import { getAdminIdentity } from '@/lib/auth/require-admin';
import { LoginForm } from '@/components/login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  // Already signed in and authorised? Skip the form.
  const identity = await getAdminIdentity();
  if (identity) {
    redirect('/dashboard');
  }

  const params = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-700 dark:bg-slate-900">
        <h1 className="text-xl font-semibold">CardBridge</h1>
        <p className="mt-1 mb-6 text-sm text-slate-500">管理者のみ利用できます</p>

        {params.sent ? (
          <div className="mb-4 rounded border border-green-300 bg-green-50 p-3 text-sm text-green-900">
            ログインリンクを送信しました。メールをご確認ください。
          </div>
        ) : null}

        {params.error ? (
          <div className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            {params.error}
          </div>
        ) : null}

        <LoginForm />
      </div>
    </div>
  );
}
