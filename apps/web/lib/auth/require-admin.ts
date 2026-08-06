import 'server-only';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { adminUsers, getDb } from '@cardbridge/db';
import { createSupabaseServerClient } from './supabase-server';

/**
 * The authorisation gate for every admin surface.
 *
 * Two checks, deliberately separate:
 *   1. Supabase says this session belongs to a real, authenticated user.
 *   2. That user has a live row in admin_users.
 *
 * The second matters because "can log in" and "may operate the seller account"
 * are different questions. If Supabase auth is ever opened up — an invite link,
 * a shared project, a misconfigured provider — having an account still grants
 * nothing here.
 *
 * `import 'server-only'` makes it a build error to pull this into a client
 * component, so the check cannot be accidentally relocated somewhere a user
 * could skip it.
 */

export interface AdminIdentity {
  id: string;
  email: string;
  role: string;
}

export async function getAdminIdentity(): Promise<AdminIdentity | null> {
  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    // Auth is not configured. Returning null means nobody is an admin, which
    // is the safe direction: a misconfigured deployment locks everyone out
    // rather than letting everyone in.
    return null;
  }

  // getUser() revalidates against Supabase. getSession() only reads the cookie,
  // which a client could have tampered with.
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;

  const db = getDb();
  const rows = await db.select().from(adminUsers).where(eq(adminUsers.id, user.id)).limit(1);

  const admin = rows[0];
  if (!admin || admin.isActive !== 'true') return null;

  return { id: admin.id, email: admin.email, role: admin.role };
}

/** Use at the top of every admin page and server action. Redirects if not an admin. */
export async function requireAdmin(): Promise<AdminIdentity> {
  const identity = await getAdminIdentity();
  if (!identity) {
    redirect('/login');
  }
  return identity;
}
