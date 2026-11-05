import type { ReactNode } from 'react';

export const metadata = { title: 'Vector Studio alpha install check (Next.js)', icons: 'data:,' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
