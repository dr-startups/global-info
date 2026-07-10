import { randomUUID } from "node:crypto";
import { resolveRuntimeStrategy, parseRuntimeMode } from "../agents/runtime-strategy";
import type {
  ProviderRuntimeMode,
  ReportLiveProviderSmokeDiagnostics,
  ReportLiveProviderSmokeRow,
} from "../types";
import { getProviderStatus } from "./config";
import { externalGoogleSerpProvider } from "./external-google-serp-provider";
import { yandexSearchProvider } from "./yandex-search-provider";
import type { ProviderRunResult, SearchProviderRequest } from "./types";
import { wikipediaProvider } from "./wikipedia-provider";
import { listComplianceProviderStatus } from "../compliance-providers/config";
import { buildOrionQueryPlanDetailed } from "../search-surfaces/orion-query-plan";

type SmokeRuntimeKind = ReportLiveProviderSmokeRow["runtimeKind"];

function toLatencyBucket(ms: number): ReportLiveProviderSmokeRow["latencyBucket"] {
  if (!Number.isFinite(ms) || ms <= 0) return "none";
  if (ms > 8_000) return "timeout";
  if (ms <= 800) return "fast";
  if (ms <= 2_500) return "normal";
  return "slow";
}

function toCountBucket(n: number): ReportLiveProviderSmokeRow["resultCountBucket"] {
  if (!Number.isFinite(n) || n < 0) return "none";
  if (n === 0) return "zero";
  if (n <= 5) return "one_to_five";
  if (n <= 20) return "six_to_twenty";
  return "many";
}

function safeErrorClass(run: ProviderRunResult | { error?: { code?: string } } | null | undefined): string | undefined {
  const code = run?.error?.code;
  return typeof code === "string" && code.trim() ? code.trim() : undefined;
}

function baseRow(input: {
  providerId: string;
  providerLabel: string;
  category: string;
  runtimeKind: SmokeRuntimeKind;
  configured: boolean;
  credentialsPresent: boolean;
  smokeStatus?: ReportLiveProviderSmokeRow["smokeStatus"];
  smokeSkippedReason?: string;
  warningCodes?: string[];
}): ReportLiveProviderSmokeRow {
  return {
    providerId: input.providerId,
    providerLabel: input.providerLabel,
    category: input.category,
    runtimeKind: input.runtimeKind,
    configured: input.configured,
    credentialsPresent: input.credentialsPresent,
    smokeAttempted: false,
    smokeSkippedReason: input.smokeSkippedReason,
    smokeStatus: input.smokeStatus ?? "skipped",
    latencyBucket: "none",
    resultCountBucket: "none",
    fallbackUsed: false,
    warningCodes: input.warningCodes,
  };
}

function deterministicQuery(): { ru: string; intl: string } {
  const details = buildOrionQueryPlanDetailed(
    {
      fullName: "Иван Иванов",
      aliases: ["Ivan Ivanov"],
      targetRegions: ["RU", "INTERNATIONAL"],
    },
    {
      maxPrimaryPerRegion: 1,
      includeRiskProbes: false,
      regions: ["RU", "INTERNATIONAL"],
    }
  );
  const ru = details.plan.find((q) => q.region === "RU")?.query ?? "\"Иван Иванов\"";
  const intl =
    details.plan.find((q) => q.region === "INTERNATIONAL")?.query ?? "\"Ivan Ivanov\" profile";
  return { ru, intl };
}

async function runSearchProbe(
  row: ReportLiveProviderSmokeRow,
  run: () => Promise<ProviderRunResult>
): Promise<void> {
  const started = Date.now();
  row.smokeAttempted = true;
  try {
    const result = await run();
    const elapsed = Date.now() - started;
    row.latencyBucket = toLatencyBucket(elapsed);
    row.safeErrorClass = safeErrorClass(result);
    row.resultCountBucket = toCountBucket(Array.isArray(result.results) ? result.results.length : 0);
    if (result.status === "SUCCESS") {
      row.smokeStatus = "pass";
      return;
    }
    if (result.status === "NOT_CONFIGURED" || result.status === "DISABLED") {
      row.smokeStatus = "unavailable";
      return;
    }
    row.smokeStatus = "fail";
  } catch (err) {
    row.latencyBucket = toLatencyBucket(Date.now() - started);
    row.smokeStatus = "fail";
    row.safeErrorClass = err instanceof Error ? err.name : "UnknownError";
  }
}

function summarize(
  rows: ReportLiveProviderSmokeRow[]
): ReportLiveProviderSmokeDiagnostics["summary"] {
  const attempted = rows.filter((r) => r.smokeAttempted);
  return {
    attemptedCount: attempted.length,
    passCount: rows.filter((r) => r.smokeStatus === "pass").length,
    failCount: rows.filter((r) => r.smokeStatus === "fail").length,
    skippedCount: rows.filter((r) => r.smokeStatus === "skipped").length,
    unavailableCount: rows.filter((r) => r.smokeStatus === "unavailable").length,
    fallbackCount: rows.filter((r) => r.fallbackUsed || r.smokeStatus === "fallback").length,
    realAttemptCount: attempted.filter((r) => r.runtimeKind === "real").length,
    mockAttemptCount: attempted.filter((r) => r.runtimeKind !== "real").length,
    warningCount: rows.reduce((acc, row) => acc + (row.warningCodes?.length ?? 0), 0),
  };
}

export interface LiveProviderSmokeOptions {
  requestedRuntimeMode?: ProviderRuntimeMode | string;
  allowLiveCalls?: boolean;
  simulateRealFailure?: boolean;
}

export async function runLiveProviderSmoke(
  options: LiveProviderSmokeOptions = {}
): Promise<ReportLiveProviderSmokeDiagnostics> {
  const parsed = parseRuntimeMode(options.requestedRuntimeMode);
  const requestedRuntimeMode = parsed ?? "legacy_mock_first";
  const resolved = resolveRuntimeStrategy({
    mode: requestedRuntimeMode,
    requestedBy: options.requestedRuntimeMode ? "request" : "default",
  });
  const allowLiveCalls = Boolean(options.allowLiveCalls);
  const simulateRealFailure = Boolean(options.simulateRealFailure);
  const q = deterministicQuery();
  const warningInvalidMode =
    options.requestedRuntimeMode && !parsed ? ["invalid_runtime_mode_normalized"] : undefined;

  const yandexRealStatus = getProviderStatus("YANDEX");
  const googleRealStatus = getProviderStatus("GOOGLE");
  const wikipediaReady = wikipediaProvider.availability().status === "ENABLED";
  const extGoogleStatus = externalGoogleSerpProvider.status();
  const compliance = listComplianceProviderStatus();

  const rows: ReportLiveProviderSmokeRow[] = [
    baseRow({
      providerId: "yandex_real",
      providerLabel: "Yandex Search Real",
      category: "search",
      runtimeKind: "real",
      configured: yandexRealStatus.configured,
      credentialsPresent: yandexRealStatus.missingConfigKeys.length === 0,
    }),
    baseRow({
      providerId: "google_real",
      providerLabel: "Google Search Real",
      category: "search",
      runtimeKind: "real",
      configured: googleRealStatus.configured,
      credentialsPresent: googleRealStatus.missingConfigKeys.length === 0,
    }),
    baseRow({
      providerId: "serper_real",
      providerLabel: "Serper External Search",
      category: "surface",
      runtimeKind: "real",
      configured: extGoogleStatus.state === "READY",
      credentialsPresent: extGoogleStatus.state === "READY",
      smokeStatus: extGoogleStatus.state === "NOT_IMPLEMENTED" ? "not_supported" : "skipped",
      smokeSkippedReason: extGoogleStatus.state === "NOT_IMPLEMENTED" ? "provider_not_implemented" : undefined,
    }),
    baseRow({
      providerId: "wikipedia_real",
      providerLabel: "Wikipedia Real",
      category: "knowledge",
      runtimeKind: "real",
      configured: wikipediaReady,
      credentialsPresent: true,
    }),
    baseRow({
      providerId: "google_mock",
      providerLabel: "Google Search Mock",
      category: "search",
      runtimeKind: "mock",
      configured: true,
      credentialsPresent: true,
      smokeStatus: "skipped",
    }),
    baseRow({
      providerId: "yandex_mock",
      providerLabel: "Yandex Search Mock",
      category: "search",
      runtimeKind: "mock",
      configured: true,
      credentialsPresent: true,
      smokeStatus: "skipped",
    }),
    baseRow({
      providerId: "screenshot_real",
      providerLabel: "Browser SERP Capture (Playwright)",
      category: "screenshot",
      runtimeKind: "real",
      configured: true,
      credentialsPresent: Boolean(
        process.env.SERP_CAPTURE_PROXY_RU || process.env.SERP_CAPTURE_PROXY_UAE
      ),
      smokeStatus: "skipped",
      smokeSkippedReason: "live-capture-via-report-run-api",
    }),
    baseRow({
      providerId: "screenshot_synthetic",
      providerLabel: "Synthetic SERP Screenshot",
      category: "screenshot",
      runtimeKind: "synthetic",
      configured: true,
      credentialsPresent: true,
      smokeStatus: "pass",
    }),
    baseRow({
      providerId: "synthetic_serp",
      providerLabel: "Synthetic SERP Builder",
      category: "surface",
      runtimeKind: "synthetic",
      configured: true,
      credentialsPresent: true,
      smokeStatus: "pass",
    }),
    baseRow({
      providerId: "compliance_manual",
      providerLabel: "Manual Compliance Import",
      category: "compliance",
      runtimeKind: "manual",
      configured: true,
      credentialsPresent: true,
      smokeStatus: "pass",
    }),
  ];

  for (const status of compliance.filter((s) => s.name !== "MANUAL_IMPORT")) {
    rows.push(
      baseRow({
        providerId: `compliance_${String(status.name).toLowerCase()}`,
        providerLabel: status.label,
        category: "compliance",
        runtimeKind: "real",
        configured: status.configured,
        credentialsPresent: status.missingConfigKeys.length === 0,
        smokeStatus: status.supportsRealCalls ? "skipped" : "unavailable",
        smokeSkippedReason: status.supportsRealCalls ? "connector_not_wired" : "missing_config",
      })
    );
  }

  const row = (id: string) => rows.find((r) => r.providerId === id);
  const realIds = ["yandex_real", "google_real", "serper_real", "wikipedia_real"] as const;
  const mockIds = ["yandex_mock", "google_mock"] as const;
  const isRealMode = resolved.mode === "real_only" || resolved.mode === "real_first_with_fallback";

  for (const id of mockIds) {
    const r = row(id);
    if (!r) continue;
    if (resolved.mode === "mock_only" || resolved.mode === "legacy_mock_first") {
      r.smokeAttempted = true;
      r.smokeStatus = "pass";
      r.resultCountBucket = "none";
      continue;
    }
    r.smokeStatus = "skipped";
    r.smokeSkippedReason = resolved.mode === "real_only" ? "real_only_no_mock" : "await_fallback";
  }

  for (const id of realIds) {
    const r = row(id);
    if (!r) continue;
    if (resolved.mode === "mock_only") {
      r.smokeStatus = "skipped";
      r.smokeSkippedReason = "runtime_mode_mock_only";
      continue;
    }
    if (resolved.mode === "legacy_mock_first") {
      r.smokeStatus = "skipped";
      r.smokeSkippedReason = "legacy_mock_first_default";
      continue;
    }
    if (!r.configured) {
      if (resolved.mode === "real_first_with_fallback") {
        const fallback = id.startsWith("google") ? row("google_mock") : id.startsWith("yandex") ? row("yandex_mock") : undefined;
        r.smokeStatus = fallback ? "fallback" : "unavailable";
        r.fallbackUsed = Boolean(fallback);
        r.fallbackProviderId = fallback?.providerId;
        if (fallback) {
          fallback.smokeAttempted = true;
          fallback.smokeStatus = "pass";
        }
      } else {
        r.smokeStatus = "unavailable";
      }
      r.smokeSkippedReason = "missing_config";
      continue;
    }
    if (!allowLiveCalls) {
      if (simulateRealFailure && resolved.mode === "real_first_with_fallback") {
        const fallback = id.startsWith("google")
          ? row("google_mock")
          : id.startsWith("yandex")
            ? row("yandex_mock")
            : undefined;
        r.smokeStatus = fallback ? "fallback" : "unavailable";
        r.fallbackUsed = Boolean(fallback);
        r.fallbackProviderId = fallback?.providerId;
        r.smokeSkippedReason = "simulated_real_failure";
        if (fallback) {
          fallback.smokeAttempted = true;
          fallback.smokeStatus = "pass";
        }
        continue;
      }
      r.smokeStatus = "skipped";
      r.smokeSkippedReason = "live_calls_disabled";
      continue;
    }
  }

  if (allowLiveCalls && isRealMode) {
    const yandex = row("yandex_real");
    if (yandex?.configured && !yandex.smokeAttempted) {
      const req: SearchProviderRequest = {
        caseId: "r53-smoke",
        subjectFullName: "Иван Иванов",
        aliases: ["Ivan Ivanov"],
        query: q.ru,
        language: "ru",
        region: "ru",
        limit: 1,
      };
      await runSearchProbe(yandex, () => yandexSearchProvider.search(req));
    }

    const google = row("google_real");
    if (google?.configured && !google.smokeAttempted) {
      const req: SearchProviderRequest = {
        caseId: "r53-smoke",
        subjectFullName: "Ivan Ivanov",
        aliases: ["Иван Иванов"],
        query: q.intl,
        language: "en",
        region: "us",
        limit: 1,
      };
      await runSearchProbe(google, () => externalGoogleSerpProvider.search(req));
      if (resolved.mode === "real_first_with_fallback" && google.smokeStatus === "fail") {
        const fallback = row("google_mock");
        if (fallback) {
          fallback.smokeAttempted = true;
          fallback.smokeStatus = "pass";
          google.fallbackUsed = true;
          google.fallbackProviderId = fallback.providerId;
          google.smokeStatus = "fallback";
        }
      }
    }

    const serper = row("serper_real");
    if (serper?.configured && !serper.smokeAttempted) {
      const req: SearchProviderRequest = {
        caseId: "r53-smoke",
        subjectFullName: "Ivan Ivanov",
        aliases: ["Иван Иванов"],
        query: q.intl,
        language: "en",
        region: "us",
        limit: 1,
      };
      await runSearchProbe(serper, () => externalGoogleSerpProvider.search(req));
      if (resolved.mode === "real_first_with_fallback" && serper.smokeStatus === "fail") {
        const fallback = row("google_mock");
        if (fallback) {
          fallback.smokeAttempted = true;
          fallback.smokeStatus = "pass";
          serper.fallbackUsed = true;
          serper.fallbackProviderId = fallback.providerId;
          serper.smokeStatus = "fallback";
        }
      }
    }

    const wiki = row("wikipedia_real");
    if (wiki?.configured && !wiki.smokeAttempted) {
      const started = Date.now();
      wiki.smokeAttempted = true;
      try {
        const res = await wikipediaProvider.lookup({
          subjectFullName: "Иван Иванов",
          aliases: ["Ivan Ivanov"],
        });
        wiki.latencyBucket = toLatencyBucket(Date.now() - started);
        wiki.safeErrorClass = res.error?.code;
        const count = res.languages.reduce((acc, lang) => acc + (lang.exists ? 1 : 0), 0);
        wiki.resultCountBucket = toCountBucket(count);
        wiki.smokeStatus = res.status === "SUCCESS" ? "pass" : res.status === "DISABLED" ? "unavailable" : "fail";
      } catch (err) {
        wiki.latencyBucket = toLatencyBucket(Date.now() - started);
        wiki.smokeStatus = "fail";
        wiki.safeErrorClass = err instanceof Error ? err.name : "UnknownError";
      }
    }
  }

  return {
    smokeRunId: `r53-${randomUUID()}`,
    requestedRuntimeMode,
    resolvedRuntimeMode: resolved.mode,
    providerRows: rows.map((r) => ({
      ...r,
      warningCodes: [...(r.warningCodes ?? []), ...(warningInvalidMode ?? [])],
    })),
    summary: summarize(rows),
  };
}
