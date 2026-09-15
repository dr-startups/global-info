import type { Metadata } from "next";
import { ServiceScreen, WizardFrame } from "@/modules/site/components/check/parts";
import { SERVICE_SCREENS } from "@/modules/site/content/check";
import { checkPageMetadata } from "@/modules/site/seo/metadata";

export const metadata: Metadata = checkPageMetadata;

/** Лимит по адресу сработал при создании: проверки ещё нет, данные формы не сохранены. */
export default function CheckLimitPage() {
  return (
    <WizardFrame>
      <ServiceScreen content={SERVICE_SCREENS.limit} />
    </WizardFrame>
  );
}
