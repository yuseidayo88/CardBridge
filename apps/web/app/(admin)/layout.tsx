import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/require-admin';
import { loadSettings } from '@/lib/settings';
import { DryRunBanner } from '@/components/dry-run-banner';

const NAV = [
  { href: '/dashboard', label: 'ダッシュボード' },
  { href: '/suppliers', label: '仕入れ先' },
  { href: '/products', label: '商品一覧' },
  { href: '/matching', label: '商品統合' },
  { href: '/images', label: '画像確認' },
  { href: '/settings/costs', label: 'コスト・配送' },
  { href: '/settings/system', label: 'システム設定' },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Every admin page is gated here, so an individual page cannot forget to
  // check. Pages that perform mutations still call requireAdmin() themselves —
  // a layout guard does not protect a server action.
  const admin = await requireAdmin();
  const settings = await loadSettings();

  return (
    <div className="min-h-screen">
      <DryRunBanner
        dryRun={settings.dryRun}
        allowProductionPublish={settings.allowProductionPublish}
        environment={process.env.EBAY_ENV ?? 'SANDBOX'}
      />

      <div className="flex">
        <aside className="w-56 shrink-0 border-r border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <div className="mb-6">
            <div className="text-lg font-semibold">CardBridge</div>
            <div className="truncate text-xs text-slate-500" title={admin.email}>
              {admin.email}
            </div>
          </div>
          <nav className="flex flex-col gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>

        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
