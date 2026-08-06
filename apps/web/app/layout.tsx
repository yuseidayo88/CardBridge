import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CardBridge',
  description: 'PSA10 Pokemon card sourcing and eBay listing management',
  // This is an internal admin tool; it should never be indexed.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
