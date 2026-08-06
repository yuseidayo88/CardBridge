/**
 * Persistent state banner.
 *
 * Always visible, on every admin page. The failure mode this prevents is
 * someone spending an afternoon approving listings while believing they are
 * live — or, much worse, believing they are in Sandbox while they are not.
 * The banner is loudest in exactly the state that deserves the most care:
 * production writes enabled.
 */
export function DryRunBanner({
  dryRun,
  allowProductionPublish,
  environment,
}: {
  dryRun: boolean;
  allowProductionPublish: boolean;
  environment: string;
}) {
  const liveWritesEnabled = !dryRun && allowProductionPublish && environment === 'PRODUCTION';

  if (liveWritesEnabled) {
    return (
      <div className="bg-red-600 px-4 py-2 text-center text-sm font-semibold text-white">
        本番出品が有効です — 承認した商品は実際に eBay へ出品されます
        <span className="ml-2 font-normal opacity-90">
          (DRY_RUN=false / ALLOW_PRODUCTION_PUBLISH=true / EBAY_ENV=PRODUCTION)
        </span>
      </div>
    );
  }

  if (dryRun) {
    return (
      <div className="bg-amber-500 px-4 py-2 text-center text-sm font-medium text-amber-950">
        Dry Run 有効 — eBay への書き込みは一切行われません（環境: {environment}）
      </div>
    );
  }

  // Dry run off but an interlock still holding: worth stating explicitly, since
  // "why did nothing publish?" is otherwise a confusing afternoon.
  return (
    <div className="bg-slate-700 px-4 py-2 text-center text-sm text-slate-100">
      Dry Run 無効、ただし本番出品は未許可 — {environment} 環境で動作中
      {!allowProductionPublish && '（ALLOW_PRODUCTION_PUBLISH が false）'}
    </div>
  );
}
