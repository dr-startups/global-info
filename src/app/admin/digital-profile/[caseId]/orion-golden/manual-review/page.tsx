import { ManualReviewAdminView } from "@/modules/digital-profile/client/ManualReviewAdminView";
import { requireOrionAdminPageAccess } from "@/modules/digital-profile/orion-golden/auth/orion-admin-auth";

/**
 * R10.10a — Server-side auth before rendering sensitive manual-review UI.
 * Does not fetch queue/evidence here; client loads after page guard passes.
 */
export default async function ManualReviewPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  await requireOrionAdminPageAccess(caseId);
  return <ManualReviewAdminView caseId={caseId} />;
}
