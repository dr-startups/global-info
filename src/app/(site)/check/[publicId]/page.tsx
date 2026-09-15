import type { Metadata } from "next";
import { CheckWizard } from "@/modules/site/components/check/CheckWizard";
import { checkPageMetadata } from "@/modules/site/seo/metadata";

/**
 * Мастер проверки. Данные конкретного человека приходят только через
 * `/api/self-check/*` — страница базу не читает и в поиск не попадает.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = checkPageMetadata;

type Props = { params: Promise<{ publicId: string }> };

export default async function CheckPage({ params }: Props) {
  const { publicId } = await params;
  return <CheckWizard publicId={publicId} />;
}
