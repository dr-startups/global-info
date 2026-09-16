import type { Metadata } from "next";
import { LegalPage } from "@/modules/site/components/LegalPage";
import { LEGAL_DOCUMENTS } from "@/modules/site/content/legal";
import { pageMetadata } from "@/modules/site/seo/metadata";

export const metadata: Metadata = pageMetadata("/legal/politika-konfidencialnosti");

export default function PrivacyPage() {
  return <LegalPage doc={LEGAL_DOCUMENTS.privacy} />;
}
