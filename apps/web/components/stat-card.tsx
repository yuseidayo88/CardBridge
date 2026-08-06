import Link from 'next/link';

type Tone = 'neutral' | 'ok' | 'warn' | 'danger';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'text-slate-900 dark:text-slate-100',
  ok: 'text-green-700 dark:text-green-400',
  warn: 'text-amber-700 dark:text-amber-400',
  danger: 'text-red-700 dark:text-red-400',
};

/**
 * A single dashboard figure.
 *
 * Counts that represent a queue of human work (items needing review) are
 * clickable and land on that queue pre-filtered — a number a person cannot act
 * on is just decoration.
 */
export function StatCard({
  label,
  value,
  tone = 'neutral',
  href,
}: {
  label: string;
  value: number;
  tone?: Tone;
  href?: string;
}) {
  const body = (
    <div className="rounded-lg border border-slate-200 bg-white p-4 transition-colors hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${TONE_CLASSES[tone]}`}>
        {value.toLocaleString('ja-JP')}
      </div>
    </div>
  );

  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}
