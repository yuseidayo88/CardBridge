'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { cardNames, getDb } from '@cardbridge/db';
import { cardNameKey } from '@cardbridge/core';
import { requireAdmin } from '@/lib/auth/require-admin';

const PATH = '/settings/card-names';

/**
 * Editing the Japanese-to-English card name table.
 *
 * The table is what lets the system build an eBay title without asking a model
 * to invent an English release name, so the quality bar for a row is high: a
 * wrong row here silently mislabels every future listing of that card, and it
 * looks correct to whoever approves it.
 */

const entrySchema = z.object({
  nameJa: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().min(1).max(200),
  // Empty string means "applies across sets", which is a real and useful kind
  // of row. Coercing it to null here keeps that meaning explicit in the DB.
  setCode: z
    .string()
    .trim()
    .max(50)
    .transform((v) => (v.length === 0 ? null : v)),
  cardNumber: z
    .string()
    .trim()
    .max(50)
    .transform((v) => (v.length === 0 ? null : v)),
  note: z
    .string()
    .trim()
    .max(500)
    .transform((v) => (v.length === 0 ? null : v)),
});

function back(params: Record<string, string>): never {
  redirect(`${PATH}?${new URLSearchParams(params).toString()}`);
}

export async function addCardName(formData: FormData): Promise<void> {
  const admin = await requireAdmin();

  const parsed = entrySchema.safeParse({
    nameJa: formData.get('nameJa') ?? '',
    nameEn: formData.get('nameEn') ?? '',
    setCode: formData.get('setCode') ?? '',
    cardNumber: formData.get('cardNumber') ?? '',
    note: formData.get('note') ?? '',
  });

  if (!parsed.success) {
    back({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  }

  const entry = parsed.data;

  // A row an admin typed while looking at the card is the most trustworthy
  // source this system has, so it is verified on entry — and attributed, which
  // the DB requires of anything claiming verification.
  let outcome: Record<string, string>;
  try {
    await getDb()
      .insert(cardNames)
      .values({
        nameJa: entry.nameJa,
        nameKey: cardNameKey(entry.nameJa),
        nameEn: entry.nameEn,
        setCode: entry.setCode,
        cardNumber: entry.cardNumber,
        note: entry.note,
        source: 'admin-entry',
        isVerified: true,
        verifiedBy: admin.email,
        verifiedAt: new Date(),
      });
    outcome = { added: entry.nameEn };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome =
      message.includes('card_names_full_uq') || message.includes('card_names_name_only_uq')
        ? { error: 'この組み合わせはすでに登録されています。' }
        : { error: message };
  }

  revalidatePath(PATH);
  back(outcome);
}

export async function deleteCardName(formData: FormData): Promise<void> {
  await requireAdmin();

  const id = formData.get('id');
  if (typeof id !== 'string' || id.length === 0) back({ error: 'id が指定されていません' });

  await getDb().delete(cardNames).where(eq(cardNames.id, id));

  revalidatePath(PATH);
  back({ deleted: '1' });
}

/**
 * Confirm an imported row.
 *
 * Unverified rows resolve at a confidence capped below the publish floor, so
 * this is the action that lets a bulk import actually produce listings — one
 * human decision per card, which is the point.
 */
export async function verifyCardName(formData: FormData): Promise<void> {
  const admin = await requireAdmin();

  const id = formData.get('id');
  if (typeof id !== 'string' || id.length === 0) back({ error: 'id が指定されていません' });

  await getDb()
    .update(cardNames)
    .set({
      isVerified: true,
      verifiedBy: admin.email,
      verifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(cardNames.id, id), eq(cardNames.isVerified, false)));

  revalidatePath(PATH);
  back({ verified: '1' });
}

/**
 * Bulk import from pasted TSV/CSV.
 *
 * Rows arrive unverified regardless of where they came from. An import is a
 * claim, not a confirmation, and the lookup treats it accordingly until an
 * admin says otherwise.
 */
export async function importCardNames(formData: FormData): Promise<void> {
  await requireAdmin();

  const raw = formData.get('rows');
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    back({ error: '貼り付ける行がありません' });
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const values: Array<typeof cardNames.$inferInsert> = [];
  const rejected: string[] = [];

  for (const [index, line] of lines.entries()) {
    // Tab first, then comma. Card names contain commas far more often than
    // tabs, so preferring the comma would split names in half.
    const parts = (line.includes('\t') ? line.split('\t') : line.split(',')).map((p) => p.trim());
    const [nameJa, nameEn, setCode, cardNumber] = parts;

    if (!nameJa || !nameEn) {
      rejected.push(`${index + 1}行目`);
      continue;
    }

    values.push({
      nameJa,
      nameKey: cardNameKey(nameJa),
      nameEn,
      setCode: setCode && setCode.length > 0 ? setCode : null,
      cardNumber: cardNumber && cardNumber.length > 0 ? cardNumber : null,
      source: 'bulk-import',
      isVerified: false,
    });
  }

  let inserted = 0;
  if (values.length > 0) {
    // Duplicates are skipped rather than failing the batch: re-importing an
    // updated list is a normal thing to do, and it should not require deleting
    // everything first.
    const result = await getDb()
      .insert(cardNames)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: cardNames.id });
    inserted = result.length;
  }

  revalidatePath(PATH);
  back({
    imported: String(inserted),
    skipped: String(values.length - inserted),
    ...(rejected.length > 0 ? { rejected: rejected.join(', ') } : {}),
  });
}

/** Count rows, for the dashboard and the empty-state message. */
export async function countCardNames(): Promise<{ total: number; verified: number }> {
  const db = getDb();
  const rows = await db.execute<{ total: string; verified: string }>(sql`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE is_verified) AS verified
    FROM card_names
  `);
  const row = rows[0];
  return { total: Number(row?.total ?? 0), verified: Number(row?.verified ?? 0) };
}
