import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/**
 * Supabase client for server components and server actions.
 *
 * This uses the anon key and the caller's session cookie — it authenticates
 * the human, nothing more. It deliberately does NOT use the service role: data
 * access happens through the Drizzle connection in @cardbridge/db, after
 * requireAdmin() has established who is asking.
 *
 * Keeping authentication and data access on separate credentials means a bug in
 * a page component cannot turn into unrestricted database access.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set');
  }

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Session refresh is handled by middleware instead.
        }
      },
    },
  });
}
