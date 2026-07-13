/**
 * Collect Arsenkin First36 pilot surfaces (check-top / suggest / paa) for one subject.
 * Uses live API when configured; otherwise fixtures (no limit spend).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArsenkinClient } from "./client";
import { createArsenkinClientFromEnv } from "./client";
import { isArsenkinConfigured, isArsenkinToolEnabled, type ArsenkinToolName } from "./flags";
import { ensureArsenkinTask, pollArsenkinTask } from "./poll-worker";
import { createMemoryProviderTaskStore, type ProviderTaskStore } from "./provider-task-store";
import { buildCheckTopRequest, mapCheckTopToObservations } from "./adapters/check-top";
import { buildSuggestRequest, mapSuggestToObservations } from "./adapters/suggest";
import { buildPaaRequest, mapPaaToObservations } from "./adapters/paa";
import { ARSENKIN_REGION, pilotSeForRegion } from "./regions";
import type { SerpObservationDraft } from "../../serp-observation/types";

const FIX = join(
  process.cwd(),
  "src/modules/digital-profile/providers/arsenkin/fixtures"
);

function loadFix(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), "utf-8"));
}

export type ArsenkinPilotCollectInput = {
  caseId: string;
  auditRunId: string;
  queriesRu: string[];
  queriesUae: string[];
  /** Force fixtures even if token present. */
  fixturesOnly?: boolean;
  /** Limit which tools to run (default: all enabled). */
  tools?: ArsenkinToolName[];
  client?: ArsenkinClient | null;
  store?: ProviderTaskStore;
  waitTimeoutMs?: number;
};

export type ArsenkinPilotCollectResult = {
  mode: "live" | "fixtures";
  drafts: SerpObservationDraft[];
  bySurface: { organic: number; autocomplete: number; paa: number };
  taskIds: string[];
};

async function completeTask(
  client: ArsenkinClient,
  store: ProviderTaskStore,
  toolName: string,
  data: Record<string, unknown>,
  meta: { caseId: string; auditRunId: string },
  waitTimeoutMs: number
): Promise<Record<string, unknown>> {
  let row = await ensureArsenkinTask(client, store, {
    toolName,
    data,
    caseId: meta.caseId,
    reportRunId: meta.auditRunId,
  });
  const started = Date.now();
  while (row.state !== "DONE" && row.state !== "FAILED" && row.state !== "CANCELLED") {
    if (Date.now() - started > waitTimeoutMs) {
      throw new Error(`Arsenkin task timeout tool=${toolName} id=${row.externalTaskId}`);
    }
    row = await pollArsenkinTask(client, store, row);
    if (row.state !== "DONE") {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (row.state !== "DONE" || !row.responseJson) {
    throw new Error(`Arsenkin task ${row.state}: ${row.errorCode ?? toolName}`);
  }
  return row.responseJson;
}

export async function collectArsenkinPilotSurfaces(
  input: ArsenkinPilotCollectInput
): Promise<ArsenkinPilotCollectResult> {
  const store = input.store ?? createMemoryProviderTaskStore();
  const live =
    !input.fixturesOnly &&
    isArsenkinConfigured() &&
    (input.client != null || createArsenkinClientFromEnv() != null);
  const client = input.client ?? (live ? createArsenkinClientFromEnv() : null);
  const drafts: SerpObservationDraft[] = [];
  const taskIds: string[] = [];
  const waitTimeoutMs = input.waitTimeoutMs ?? 10 * 60_000;

  const ruQuery = input.queriesRu[0] ?? "subject";
  const uaeQuery = input.queriesUae[0] ?? ruQuery;
  const want = (tool: ArsenkinToolName) =>
    (!input.tools || input.tools.includes(tool)) &&
    (isArsenkinToolEnabled(tool) || input.fixturesOnly || !live);

  // --- check-top RU ---
  if (want("check-top")) {
    const se = pilotSeForRegion("RU");
    const req = buildCheckTopRequest({
      queries: input.queriesRu.slice(0, 3),
      se,
      depth: 10,
      is_snippet: true,
    });
    const payload =
      live && client
        ? await completeTask(client, store, "check-top", req.data, input, waitTimeoutMs)
        : loadFix("get-check-top.json");
    drafts.push(
      ...mapCheckTopToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "RU",
        language: "ru",
        queries: input.queriesRu.slice(0, 3),
        se,
        payload,
      })
    );
  }

  // --- check-top UAE (Google only) ---
  if (want("check-top") && input.queriesUae.length > 0) {
    const se = pilotSeForRegion("UAE");
    const req = buildCheckTopRequest({
      queries: input.queriesUae.slice(0, 2),
      se,
      depth: 10,
      is_snippet: true,
    });
    const payload =
      live && client
        ? await completeTask(client, store, "check-top", req.data, input, waitTimeoutMs)
        : {
            result: {
              result: {
                collect: [[["https://highways.today/2025/11/06/biography-of-glinka-sergei/"]]],
                snippets: {
                  "https://highways.today/2025/11/06/biography-of-glinka-sergei/": [
                    { title: "Biography of Glinka Sergei", snippet: "UAE fixture" },
                  ],
                },
              },
            },
          };
    drafts.push(
      ...mapCheckTopToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "UAE",
        language: "en",
        queries: input.queriesUae.slice(0, 2),
        se,
        payload,
      })
    );
  }

  // --- suggest RU (Yandex) ---
  if (want("suggest")) {
    const req = buildSuggestRequest({
      queries: [ruQuery],
      se: 1,
      region: ARSENKIN_REGION.YANDEX_MOSCOW,
      depth: 1,
    });
    const payload =
      live && client
        ? await completeTask(client, store, "suggest", req.data, input, waitTimeoutMs)
        : loadFix("get-suggest.json");
    drafts.push(
      ...mapSuggestToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "RU",
        language: "ru",
        queries: [ruQuery],
        se: 1,
        payload,
      })
    );
  }

  // --- paa RU (Google-only) ---
  if (want("paa")) {
    const req = buildPaaRequest({
      queries: [ruQuery],
      region: ARSENKIN_REGION.GOOGLE_MOSCOW,
      depth: 1,
      count: 10,
    });
    const payload =
      live && client
        ? await completeTask(client, store, "paa", req.data, input, waitTimeoutMs)
        : loadFix("get-paa.json");
    drafts.push(
      ...mapPaaToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "RU",
        language: "ru",
        queries: [ruQuery],
        payload,
      })
    );
  }

  void uaeQuery;
  const bySurface = {
    organic: drafts.filter((d) => d.surface === "organic").length,
    autocomplete: drafts.filter((d) => d.surface === "autocomplete").length,
    paa: drafts.filter((d) => d.surface === "paa").length,
  };
  return {
    mode: live && client ? "live" : "fixtures",
    drafts,
    bySurface,
    taskIds,
  };
}
