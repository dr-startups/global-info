import type { Metadata } from "next";
import { ServiceScreen, WizardFrame } from "@/modules/site/components/check/parts";
import { SERVICE_SCREENS } from "@/modules/site/content/check";

export const metadata: Metadata = {
  title: SERVICE_SCREENS.notFound.status,
  robots: { index: false, follow: false },
};

/** Проверки с таким адресом нет: тот же экран, что мастер рисовал раньше, но с кодом 404. */
export default function CheckNotFound() {
  return (
    <WizardFrame>
      <ServiceScreen content={SERVICE_SCREENS.notFound} />
    </WizardFrame>
  );
}
