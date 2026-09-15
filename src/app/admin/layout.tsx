import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "../globals.css";

export const metadata: Metadata = {
  title: "Global Info — Digital Profile Audit",
  description: "Evidence-based digital profile and compliance audit admin.",
};

/**
 * Шапка админки и её стили. Разметка та же, что стояла в корневом layout до
 * появления сайта: полоса `.dp-topbar` и `<main class="dp-container">`.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="dp-topbar">
        <Link href="/admin/digital-profile" className="dp-brand">
          Global Info · Digital Profile Audit
        </Link>
      </div>
      <main className="dp-container">{children}</main>
    </>
  );
}
