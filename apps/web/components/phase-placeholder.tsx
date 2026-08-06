/**
 * Placeholder for a screen that has not been built yet.
 *
 * Deliberately explicit about which phase delivers it and what it will contain.
 * A nav link that leads to a 404 reads as a bug; one that leads to "this is
 * Phase 4, here is what it will do" reads as a plan.
 */
export function PhasePlaceholder({
  title,
  phase,
  description,
  features,
}: {
  title: string;
  phase: string;
  description: string;
  features: string[];
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-3">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-200">
          {phase} で実装
        </span>
      </div>
      <p className="mb-6 text-sm text-slate-500">{description}</p>

      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 dark:border-slate-600 dark:bg-slate-900">
        <div className="mb-3 text-sm font-medium">この画面で提供する機能</div>
        <ul className="flex flex-col gap-1.5 text-sm text-slate-600 dark:text-slate-300">
          {features.map((feature) => (
            <li key={feature} className="flex gap-2">
              <span className="text-slate-400">•</span>
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
