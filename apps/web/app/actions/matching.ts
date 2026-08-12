'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@cardbridge/db';
import { requireAdmin } from '@/lib/auth/require-admin';

const PATH = '/matching';

/**
 * Resolving "are these two shop listings the same physical card?".
 *
 * The scorer never auto-merges on a card number alone, so anything that lands
 * here is a pair a human has to decide on. Both outcomes are recorded: a
 * rejection is as informative as a merge, because without it the same pair is
 * re-proposed on every sync and the queue never empties.
 */

function back(params: Record<string, string>): never {
  redirect(`${PATH}?${new URLSearchParams(params).toString()}`);
}

function requireId(formData: FormData, field: string): string {
  const value = formData.get(field);
  if (typeof value !== 'string' || value.length === 0) {
    back({ error: `${field} が指定されていません` });
  }
  return value;
}

export async function approveMatch(formData: FormData): Promise<void> {
  const admin = await requireAdmin();

  const candidateId = requireId(formData, 'candidateId');
  const db = getDb();

  let outcome: Record<string, string>;
  try {
    // One transaction: a candidate marked resolved without its product_matches
    // row would look decided while changing nothing, which is the worst of the
    // three possible states.
    await db.transaction(async (tx) => {
      const rows = await tx.execute<{
        supplier_product_id: string;
        catalog_product_id: string;
      }>(sql`
        SELECT supplier_product_id, catalog_product_id
        FROM match_candidates
        WHERE id = ${candidateId} AND resolved_at IS NULL
        FOR UPDATE
      `);

      const candidate = rows[0];
      if (!candidate) throw new Error('その候補はすでに処理されています');

      // Re-activate a previously unmatched link rather than inserting a
      // second row for the same pair. product_matches deliberately has no
      // unique constraint -- the same pair may legitimately be matched,
      // unmatched and matched again, and each of those is a fact worth
      // keeping -- so the "is there a live link already" question is asked
      // explicitly here instead of delegated to ON CONFLICT.
      const existing = await tx.execute<{ id: string }>(sql`
        SELECT id FROM product_matches
        WHERE supplier_product_id = ${candidate.supplier_product_id}
          AND catalog_product_id = ${candidate.catalog_product_id}
          AND unmatched_at IS NULL
        LIMIT 1
      `);

      if (existing.length === 0) {
        await tx.execute(sql`
          INSERT INTO product_matches
            (supplier_product_id, catalog_product_id, match_method, match_score, matched_by)
          VALUES (${candidate.supplier_product_id}, ${candidate.catalog_product_id},
                  ${'MANUAL'}, ${1}, ${admin.email})
        `);
      }

      await tx.execute(sql`
        UPDATE match_candidates
        SET resolved_at = now(), resolved_by = ${admin.email}, resolution = ${'APPROVED'}
        WHERE id = ${candidateId}
      `);
    });
    outcome = { approved: '1' };
  } catch (error) {
    outcome = { error: error instanceof Error ? error.message : String(error) };
  }

  revalidatePath(PATH);
  back(outcome);
}

/**
 * Record that two listings are *not* the same card.
 *
 * This is not a no-op. Without a stored rejection the pair scores the same on
 * the next sync and comes straight back, so the queue grows faster than anyone
 * can work it.
 */
export async function rejectMatch(formData: FormData): Promise<void> {
  const admin = await requireAdmin();

  const candidateId = requireId(formData, 'candidateId');

  await getDb().execute(sql`
    UPDATE match_candidates
    SET resolved_at = now(), resolved_by = ${admin.email}, resolution = ${'REJECTED'}
    WHERE id = ${candidateId} AND resolved_at IS NULL
  `);

  revalidatePath(PATH);
  back({ rejected: '1' });
}

/**
 * Undo a merge.
 *
 * A soft unmatch rather than a row deletion, so a mistaken auto-merge that an
 * admin reverses leaves a trace. Without it the same bad merge silently
 * happens again on the next sync, and nobody can tell it ever went wrong.
 */
export async function unmatchProduct(formData: FormData): Promise<void> {
  const admin = await requireAdmin();

  const matchId = requireId(formData, 'matchId');

  await getDb().execute(sql`
    UPDATE product_matches
    SET unmatched_at = now(), unmatched_by = ${admin.email},
        unmatch_reason = ${'管理画面から手動で解除'}
    WHERE id = ${matchId} AND unmatched_at IS NULL
  `);

  revalidatePath(PATH);
  back({ unmatched: '1' });
}
