'use server';

import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { adminUsers, getDb } from '@cardbridge/db';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';

const emailSchema = z.string().email().max(254);

/**
 * Send a magic link.
 *
 * Two decisions worth stating:
 *
 * 1. Magic link rather than password. There is no password to leak, reuse or
 *    phish, and the admin set is small enough that the ergonomics do not
 *    matter.
 *
 * 2. The response is identical whether or not the address belongs to an admin.
 *    Saying "not an admin" would turn this form into a way to enumerate who has
 *    access to a system that can list and end items on a live seller account.
 *    Non-admins simply never receive a link.
 */
export async function requestMagicLink(formData: FormData): Promise<void> {
  const parsed = emailSchema.safeParse(formData.get('email'));
  if (!parsed.success) {
    redirect('/login?error=' + encodeURIComponent('メールアドレスの形式が正しくありません'));
  }

  const email = parsed.data.toLowerCase();

  const db = getDb();
  const rows = await db
    .select({ id: adminUsers.id, isActive: adminUsers.isActive })
    .from(adminUsers)
    .where(eq(adminUsers.email, email))
    .limit(1);

  const isAdmin = rows[0]?.isActive === 'true';

  if (isAdmin) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signInWithOtp({
      email,
      options: {
        // No self-service signup: an account must be provisioned in
        // admin_users first.
        shouldCreateUser: false,
        emailRedirectTo: `${process.env.APP_URL ?? 'http://localhost:3000'}/auth/callback`,
      },
    });
  }

  redirect('/login?sent=1');
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/login');
}
