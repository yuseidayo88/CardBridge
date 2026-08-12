'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { costProfiles, getDb } from '@cardbridge/db';
import { requireAdmin } from '@/lib/auth/require-admin';

const PATH = '/settings/costs';

/**
 * Editing the fee profile.
 *
 * Every rate here is seeded as a marked placeholder, because a hard-coded
 * 13.25% becomes quietly wrong months before anyone notices the margins
 * slipping. This action is how the placeholders get replaced with what the
 * seller's own account actually charges.
 *
 * Profit calculations store a snapshot of the profile they used, so editing a
 * profile never rewrites the reasoning behind a past decision.
 */

/**
 * Percentages arrive as strings and stay strings.
 *
 * Number() here would put a float in the path of a margin comparison, which is
 * exactly the thing decimal.js exists in this codebase to prevent. Postgres
 * numeric accepts the string; nothing needs to parse it on the way in.
 */
const percent = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => /^\d+(\.\d+)?$/.test(v), `${label}: 0以上の数値を入力してください`)
    .refine((v) => Number(v) <= 100, `${label}: 100% を超えています`);

const money = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => /^\d+(\.\d+)?$/.test(v), `${label}: 0以上の金額を入力してください`);

const profileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  categoryFeePercent: percent('落札手数料'),
  fixedFeePerOrder: money('注文ごとの固定費'),
  internationalFeePercent: percent('国際取引手数料'),
  adRatePercent: percent('プロモーション広告料率'),
  fxSpreadPercent: percent('為替スプレッド'),
  fxBufferPercent: percent('為替変動バッファ'),
  returnReservePercent: percent('返品引当'),
  packagingCost: money('梱包資材費'),
  packagingCurrency: z.enum(['JPY', 'USD']),
  otherCost: money('その他費用'),
  notes: z
    .string()
    .trim()
    .max(1000)
    .transform((v) => (v.length === 0 ? null : v)),
});

function back(params: Record<string, string>): never {
  redirect(`${PATH}?${new URLSearchParams(params).toString()}`);
}

function read(formData: FormData) {
  const get = (key: string, fallback = '') => {
    const value = formData.get(key);
    return typeof value === 'string' ? value : fallback;
  };

  return {
    name: get('name'),
    categoryFeePercent: get('categoryFeePercent', '0'),
    fixedFeePerOrder: get('fixedFeePerOrder', '0'),
    internationalFeePercent: get('internationalFeePercent', '0'),
    adRatePercent: get('adRatePercent', '0'),
    fxSpreadPercent: get('fxSpreadPercent', '0'),
    fxBufferPercent: get('fxBufferPercent', '0'),
    returnReservePercent: get('returnReservePercent', '0'),
    packagingCost: get('packagingCost', '0'),
    packagingCurrency: get('packagingCurrency', 'JPY'),
    otherCost: get('otherCost', '0'),
    notes: get('notes'),
  };
}

export async function saveCostProfile(formData: FormData): Promise<void> {
  await requireAdmin();

  const parsed = profileSchema.safeParse(read(formData));
  if (!parsed.success) {
    back({ error: parsed.error.issues.map((i) => i.message).join(' / ') });
  }

  const id = formData.get('id');
  const values = { ...parsed.data };

  let outcome: Record<string, string>;
  try {
    if (typeof id === 'string' && id.length > 0) {
      await getDb().update(costProfiles).set(values).where(eq(costProfiles.id, id));
      outcome = { saved: '1' };
    } else {
      await getDb()
        .insert(costProfiles)
        .values({ ...values, isActive: true });
      outcome = { created: '1' };
    }
  } catch (error) {
    outcome = { error: error instanceof Error ? error.message : String(error) };
  }

  revalidatePath(PATH);
  back(outcome);
}

/**
 * Retire a profile without deleting it.
 *
 * Deletion would orphan the snapshots that past profit calculations point at,
 * and "why did we list this at $310 in March" is a question that has to stay
 * answerable.
 */
export async function deactivateCostProfile(formData: FormData): Promise<void> {
  await requireAdmin();

  const id = formData.get('id');
  if (typeof id !== 'string' || id.length === 0) back({ error: 'id が指定されていません' });

  await getDb().update(costProfiles).set({ isActive: false }).where(eq(costProfiles.id, id));

  revalidatePath(PATH);
  back({ deactivated: '1' });
}
