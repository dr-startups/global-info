import { ManualReviewAdminView } from "@/modules/digital-profile/client/ManualReviewAdminView";

export default async function ManualReviewPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  return <ManualReviewAdminView caseId={caseId} />;
}
