"use client";

import type { ReactNode } from "react";
import { DigitalProfileI18nProvider } from "@/modules/digital-profile/client/i18n-provider";
import { DigitalProfileAuthProvider } from "@/modules/digital-profile/client/auth-provider";
import { LanguageToggle } from "@/modules/digital-profile/client/LanguageToggle";
import { UserBadge } from "@/modules/digital-profile/client/UserBadge";

export default function DigitalProfileAdminLayout({ children }: { children: ReactNode }) {
  return (
    <DigitalProfileI18nProvider>
      <DigitalProfileAuthProvider>
        <div
          className="dp-inline"
          style={{ justifyContent: "flex-end", gap: 12, marginBottom: 12 }}
        >
          <UserBadge />
          <LanguageToggle />
        </div>
        {children}
      </DigitalProfileAuthProvider>
    </DigitalProfileI18nProvider>
  );
}
