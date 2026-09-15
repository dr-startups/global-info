import type { Metadata } from "next";
import { LegalPage } from "@/modules/site/components/LegalPage";
import { LEGAL_DOCUMENTS } from "@/modules/site/content/legal";

const doc = LEGAL_DOCUMENTS.privacy;

export const metadata: Metadata = { title: doc.title, description: doc.description };

export default function PrivacyPage() {
  return <LegalPage doc={doc} />;
}
