import type { ReactNode } from "react";

/**
 * Корневой layout общий для публичного сайта и админки, поэтому в нём только
 * документ. Шапка и глобальные стили админки — в `admin/layout.tsx`: они ставят
 * `html { font-size: 14px }`, и здесь все `rem` сайта считались бы от 14 px.
 * Шапка, подвал и стили сайта — в `(site)/layout.tsx`.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
