import type { Prisma } from "@prisma/client";

export function buildDbIntegrationOrionReportRun(input: {
  reportRunId: string;
  caseId: string;
}): Prisma.OrionReportRunUncheckedCreateInput {
  return {
    id: input.reportRunId,
    caseId: input.caseId,
    mode: "ARSENKIN_DB_INTEGRATION_TEST",
    status: "RUNNING",
  } satisfies Prisma.OrionReportRunUncheckedCreateInput;
}

export function buildDbIntegrationProviderTask(input: {
  providerTaskId: string;
  reportRunId: string;
  requestHash: string;
}): Prisma.ProviderTaskUncheckedCreateInput {
  return {
    id: input.providerTaskId,
    reportRunId: input.reportRunId,
    provider: "arsenkin",
    toolName: "suggest",
    requestHash: input.requestHash,
    requestJson: { tools_name: "suggest", data: { queries: ["test"] } },
    state: "DONE",
  } satisfies Prisma.ProviderTaskUncheckedCreateInput;
}
