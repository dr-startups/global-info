import { CaseDetailView } from "@/modules/digital-profile/client/CaseDetailView";
import { digitalProfileConfig } from "@/modules/digital-profile/config";

export const dynamic = "force-dynamic";

export default async function DigitalProfileCasePage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  return (
    <CaseDetailView
      caseId={caseId}
      legacyReportUi={digitalProfileConfig.legacyReportUiEnabled}
      manualAgentRun={digitalProfileConfig.manualAgentRun}
    />
  );
}
