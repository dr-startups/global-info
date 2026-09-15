import type { Metadata } from "next";
import { ServiceScreen, WizardFrame } from "@/modules/site/components/check/parts";
import { SERVICE_SCREENS } from "@/modules/site/content/check";
import { checkPageMetadata } from "@/modules/site/seo/metadata";

export const metadata: Metadata = checkPageMetadata;

/**
 * Рубильник выключен, пока посетитель заполнял форму. Контакты не собираются
 * (решение владельца 14.09.2026).
 */
export default function CheckDisabledPage() {
  return (
    <WizardFrame>
      <ServiceScreen content={SERVICE_SCREENS.disabledBeforeCheck} />
    </WizardFrame>
  );
}
