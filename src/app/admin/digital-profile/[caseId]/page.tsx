import { CaseDetailView } from "@/modules/digital-profile/client/CaseDetailView";

export const dynamic = "force-dynamic";

export default async function DigitalProfileCasePage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  return <CaseDetailView caseId={caseId} />;
}
