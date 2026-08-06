import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';

/**
 * Magic-link landing endpoint: exchanges the one-time code for a session.
 *
 * The `next` parameter is validated as a same-site relative path. Reflecting an
 * arbitrary URL here would make the login flow an open redirect — a convenient
 * way to send an admin somewhere that looks like this app and asks for a fresh
 * login link.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const requestedNext = searchParams.get('next') ?? '/dashboard';

  const next =
    requestedNext.startsWith('/') && !requestedNext.startsWith('//') ? requestedNext : '/dashboard';

  if (!code) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent('ログインコードがありません')}`,
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent('ログインリンクが無効か、期限切れです')}`,
    );
  }

  return NextResponse.redirect(`${origin}${next}`);
}
