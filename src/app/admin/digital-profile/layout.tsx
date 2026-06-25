"use client";

import type { ReactNode } from "react";
import { DigitalProfileI18nProvider } from "@/modules/digital-profile/client/i18n-provider";
import { LanguageToggle } from "@/modules/digital-profile/client/LanguageToggle";

export default function DigitalProfileAdminLayout({ children }: { children: ReactNode }) {
  return (
    <DigitalProfileI18nProvider>
      <div
        className="dp-inline"
        style={{ justifyContent: "flex-end", marginBottom: 12 }}
      >
        <LanguageToggle />
      </div>
      {children}
    </DigitalProfileI18nProvider>
  );
}
