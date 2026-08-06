const STYLES: Record<string, { label: string; className: string }> = {
  CONFIRMED: {
    label: 'PSA10 確定',
    className: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  },
  REVIEW: {
    label: '要確認',
    className: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-300',
  },
  REJECTED: {
    label: '対象外',
    className: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  },
};

/**
 * The PSA verdict, rendered so REVIEW reads as an action rather than a failure.
 *
 * REVIEW is a first-class outcome in this system — an item that needs a human
 * look, not one that went wrong — and the colour choice reflects that.
 */
export function VerdictBadge({ verdict }: { verdict: string }) {
  const style = STYLES[verdict] ?? {
    label: verdict,
    className: 'bg-slate-200 text-slate-600',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}>
      {style.label}
    </span>
  );
}
