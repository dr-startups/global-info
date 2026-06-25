import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Global Info — Digital Profile Audit",
  description: "Evidence-based digital profile and compliance audit admin.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="dp-topbar">
          <Link href="/admin/digital-profile" className="dp-brand">
            Global Info · Digital Profile Audit
          </Link>
        </div>
        <main className="dp-container">{children}</main>
      </body>
    </html>
  );
}
