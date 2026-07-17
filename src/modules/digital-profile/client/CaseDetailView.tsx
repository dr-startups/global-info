"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  DigitalProfileApiError,
  generateReport,
  getCase,
  getEvidence,
  getReport,
  listAgentRuns,
  listAgents,
  listSearchSurfaces,
  renderReport,
  runFullAudit,
  prepareOrionGoldenArtifacts,
  getOrionGoldenPrepareStatus,
  startUnifiedOrionCollection,
  recoverUnifiedOrionCollection,
  retryUnifiedEnrichmentSuggestionsTask,
  getUnifiedOrionCollectionStatus,
  type AgentInfo,
  type AgentRun,
  type CaseDetail,
  type CaseEvidence,
  type FullAuditRunSummaryItem,
  type OrionGoldenPrepareSummary,
  type ReportVersion,
  type SearchSurfaceItem,
  type UnifiedCollectionJobStatus,
} from "./api";
import {
  Card,
  EmptyState,
  ErrorBox,
  Loading,
  Notice,
  SuccessBox,
} from "./components";
import { CaseHeader } from "./CaseHeader";
import { CaseTabs } from "./CaseTabs";
import { OrionV2ReportPanel } from "./OrionV2ReportPanel";
import { OrionClientStoryboardReportPanel } from "./OrionClientStoryboardReportPanel";
import { useDigitalProfileI18n } from "./i18n-provider";
import { useDpAuth } from "./auth-provider";

type LoadState =
  | { kind: "loading" }
  | { kind: "disabled" }
  | { kind: "notFound" }
  | { kind: "error"; message: string }
  | { kind: "ready"; caseDetail: CaseDetail; evidence: CaseEvidence };

export function CaseDetailView({ caseId }: { caseId: string }) {
  const { t, tError } = useDigitalProfileI18n();
  const { user, can } = useDpAuth();
  const isAdmin = user?.role === "ADMIN" || user?.role === "SUPER_ADMIN";
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [report, setReport] = useState<ReportVersion | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
  const [surfaces, setSurfaces] = useState<SearchSurfaceItem[]>([]);
  const [generating, setGenerating] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [unifiedJob, setUnifiedJob] = useState<UnifiedCollectionJobStatus | null>(null);
  const [banner, setBanner] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [prepareBusy, setPrepareBusy] = useState(false);
  const [prepareStatus, setPrepareStatus] = useState<OrionGoldenPrepareSummary | null>(null);
  const [lastFullAuditSummary, setLastFullAuditSummary] = useState<{
    mode: "legacy_mock_first" | "real_first_with_fallback" | "real_only" | "mock_only";
    items: FullAuditRunSummaryItem[];
  } | null>(null);

  const loadAll = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const [caseDetail, evidence, latestReport, agentList, runs, surfaceList, prep, unified] =
        await Promise.all([
          getCase(caseId),
          getEvidence(caseId),
          getReport(caseId),
          listAgents(caseId),
          listAgentRuns(caseId),
          listSearchSurfaces(caseId),
          getOrionGoldenPrepareStatus(caseId).catch(() => null),
          getUnifiedOrionCollectionStatus(caseId).catch(() => ({ job: null })),
        ]);
      setReport(latestReport);
      setAgents(agentList);
      setAgentRuns(runs);
      setSurfaces(surfaceList);
      if (prep) setPrepareStatus(prep);
      setUnifiedJob(unified.job);
      setState({ kind: "ready", caseDetail, evidence });
    } catch (err) {
      if (err instanceof DigitalProfileApiError) {
        if (err.code === "MODULE_DISABLED") return setState({ kind: "disabled" });
        if (err.code === "NOT_FOUND") return setState({ kind: "notFound" });
      }
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setState({ kind: "error", message: tError(code, msg) });
    }
  }, [caseId, tError]);

  const refreshEvidence = useCallback(async () => {
    try {
      const evidence = await getEvidence(caseId);
      setState((prev) =>
        prev.kind === "ready" ? { ...prev, evidence } : prev
      );
    } catch {
      // Non-fatal: keep existing data; tab-level errors are shown inline.
    }
  }, [caseId]);

  const refreshSurfaces = useCallback(async () => {
    try {
      setSurfaces(await listSearchSurfaces(caseId));
    } catch {
      // Non-fatal: inline errors are surfaced by the triggering action.
    }
  }, [caseId]);

  // Refresh agents + runs + evidence + surfaces together (after running agents).
  const refreshAgents = useCallback(async () => {
    try {
      const [agentList, runs, evidence, surfaceList] = await Promise.all([
        listAgents(caseId),
        listAgentRuns(caseId),
        getEvidence(caseId),
        listSearchSurfaces(caseId),
      ]);
      setAgents(agentList);
      setAgentRuns(runs);
      setSurfaces(surfaceList);
      setState((prev) => (prev.kind === "ready" ? { ...prev, evidence } : prev));
    } catch {
      // Non-fatal: inline errors are surfaced by the action that triggered this.
    }
  }, [caseId]);

  const pollUnifiedUntilTerminal = useCallback(async () => {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const { job } = await getUnifiedOrionCollectionStatus(caseId);
      if (!job) continue;
      setUnifiedJob(job);
      const terminal =
        job.stage === "REPORT_READY" ||
        job.stage === "COMPLETED_PARTIAL" ||
        job.stage === "FAILED_TERMINAL" ||
        job.stage === "FAILED_RETRYABLE" ||
        job.stage === "CANCELLED" ||
        job.status === "COMPLETED";
      if (!terminal) continue;
      await refreshAgents();
      if (job.stage === "REPORT_READY") {
        setBanner({ kind: "ok", text: t("agents.unifiedDone") });
      } else if (job.stage === "COMPLETED_PARTIAL") {
        setBanner({ kind: "ok", text: t("agents.unifiedPartial") });
      } else {
        setBanner({
          kind: "error",
          text: `${t("agents.unifiedFailed")} [${job.lastErrorCode ?? job.stage}] jobId=${job.jobId}${
            job.lastError ? `: ${job.lastError}` : ""
          }`,
        });
      }
      return;
    }
  }, [caseId, refreshAgents, t]);

  const handleRunUnifiedCollection = useCallback(async () => {
    if (auditing || generating || recovering) return;
    if (unifiedJob?.recoveryAllowed) {
      setBanner({
        kind: "error",
        text: `Восстанавливаемый job ${unifiedJob.jobId}. Используйте recovery, а не Full Audit.`,
      });
      return;
    }
    if (unifiedJob?.fullAuditBlocked || unifiedJob?.paidRecollectionRequired) {
      setBanner({
        kind: "error",
        text:
          "Full Audit недоступен: есть job с сохранёнными стадиями. Используйте recovery или «Начать новый аудит с повторным сбором данных».",
      });
      return;
    }
    setAuditing(true);
    setBanner(null);
    try {
      await startUnifiedOrionCollection(caseId);
      await pollUnifiedUntilTerminal();
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setBanner({ kind: "error", text: tError(code, msg) });
    } finally {
      setAuditing(false);
      const { job } = await getUnifiedOrionCollectionStatus(caseId).catch(() => ({ job: null }));
      if (job) setUnifiedJob(job);
    }
  }, [
    auditing,
    generating,
    recovering,
    caseId,
    pollUnifiedUntilTerminal,
    tError,
    unifiedJob,
  ]);

  const handlePaidRecollection = useCallback(async () => {
    if (auditing || generating || recovering) return;
    const ok = window.confirm(
      "Будут повторно вызваны платные провайдеры (Yandex/Google/Serper/Wikipedia и Arsenkin). " +
        "Текущий job не будет продолжен — создастся новый сбор. Продолжить?"
    );
    if (!ok) return;
    setAuditing(true);
    setBanner(null);
    try {
      await startUnifiedOrionCollection(caseId, { confirmPaidRecollection: true });
      await pollUnifiedUntilTerminal();
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setBanner({ kind: "error", text: tError(code, msg) });
    } finally {
      setAuditing(false);
      const { job } = await getUnifiedOrionCollectionStatus(caseId).catch(() => ({ job: null }));
      if (job) setUnifiedJob(job);
    }
  }, [auditing, generating, recovering, caseId, pollUnifiedUntilTerminal, tError]);

  const handleRecoverUnifiedCollection = useCallback(async () => {
    if (auditing || generating || recovering) return;
    const jobId = unifiedJob?.jobId;
    if (!jobId || !unifiedJob?.recoveryAllowed) {
      setBanner({
        kind: "error",
        text: `Recovery недоступен${
          unifiedJob?.recoveryBlockerReason ? ` (${unifiedJob.recoveryBlockerReason})` : ""
        }.`,
      });
      return;
    }
    const renderResume =
      unifiedJob.resumeCheckpoint === "RENDER" ||
      unifiedJob.recoveryReason === "RENDER_RESUME" ||
      unifiedJob.lastErrorCode === "RENDER_FAILED";
    const ingestResume =
      unifiedJob.resumeCheckpoint === "ARSENKIN_RESULT_INGEST" ||
      unifiedJob.recoveryReason === "ARSENKIN_INGEST_RESUME";
    const ok = window.confirm(
      renderResume
        ? "Рендер будет выполнен через renderer service. Базовый поиск и Arsenkin повторно не запускаются. Продолжить с этапа рендера?"
        : ingestResume
          ? "Будут импортированы уже выполненные Arsenkin задачи без новых submit и без повторного base-сбора. Продолжить импорт?"
          : "Базовый поиск повторно выполняться не будет. Продолжить аудит с этапа Arsenkin?"
    );
    if (!ok) return;
    setRecovering(true);
    setBanner(null);
    try {
      const recovered = await recoverUnifiedOrionCollection(caseId, jobId);
      setUnifiedJob((prev) =>
        prev
          ? {
              ...prev,
              jobId: recovered.jobId,
              unifiedJobId: recovered.unifiedJobId,
              stage: recovered.stage,
              status: recovered.status,
              baseReportRunId: recovered.baseReportRunId,
            }
          : prev
      );
      await pollUnifiedUntilTerminal();
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setBanner({ kind: "error", text: tError(code, msg) });
    } finally {
      setRecovering(false);
      const { job } = await getUnifiedOrionCollectionStatus(caseId).catch(() => ({ job: null }));
      if (job) setUnifiedJob(job);
    }
  }, [
    auditing,
    generating,
    recovering,
    caseId,
    unifiedJob,
    pollUnifiedUntilTerminal,
    tError,
  ]);

  const handleRetrySuggestions = useCallback(async () => {
    if (auditing || generating || recovering) return;
    const jobId = unifiedJob?.jobId;
    const enrichmentRunId = unifiedJob?.suggestionsEnrichmentRunId;
    if (!jobId || !enrichmentRunId || !unifiedJob?.suggestionsRetryAllowed) {
      setBanner({
        kind: "error",
        text: "Повтор Suggestions недоступен для текущего job.",
      });
      return;
    }
    const ok = window.confirm(
      "Будет отправлена одна платная задача Arsenkin. Базовый поиск и остальные агенты повторно не запускаются."
    );
    if (!ok) return;
    setRecovering(true);
    setBanner(null);
    try {
      const result = await retryUnifiedEnrichmentSuggestionsTask(caseId, {
        jobId,
        enrichmentRunId,
        agentName: unifiedJob.suggestionsAgentName ?? "SUGGESTIONS",
        confirmPaidEnrichmentRetry: true,
      });
      setUnifiedJob((prev) =>
        prev
          ? {
              ...prev,
              jobId: result.jobId,
              unifiedJobId: result.unifiedJobId,
              stage: result.stage,
              status: result.status,
            }
          : prev
      );
      setBanner({
        kind: "ok",
        text: result.reusedExisting
          ? `Suggestions: переиспользована существующая задача (${result.externalTaskId}).`
          : `Suggestions: отправлена 1 задача (${result.externalTaskId}).`,
      });
      await pollUnifiedUntilTerminal();
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setBanner({ kind: "error", text: tError(code, msg) });
    } finally {
      setRecovering(false);
      const { job } = await getUnifiedOrionCollectionStatus(caseId).catch(() => ({ job: null }));
      if (job) setUnifiedJob(job);
    }
  }, [
    auditing,
    generating,
    recovering,
    caseId,
    unifiedJob,
    pollUnifiedUntilTerminal,
    tError,
  ]);

  const handleRunAudit = useCallback(async () => {
    // Admin/diagnostic path only — primary CTA is unified collection.
    if (auditing || generating) return;
    setAuditing(true);
    setBanner(null);
    try {
      const result = await runFullAudit(caseId, {
        runtimeMode: "real_first_with_fallback",
      });
      await refreshAgents();
      setLastFullAuditSummary({
        mode: result.runtimeStrategy?.mode ?? "real_first_with_fallback",
        items: result.runSummary ?? [],
      });
      const completedCount = result.runSummary?.filter((item) => item.status === "completed").length ?? 0;
      const skippedCount = result.runSummary?.filter((item) => item.status === "skipped").length ?? 0;
      const unavailableCount = result.runSummary?.filter((item) => item.status === "unavailable").length ?? 0;
      const failedCount = result.runSummary?.filter((item) => item.status === "failed").length ?? 0;
      const fallbackCount = result.runSummary?.filter((item) => !!item.fallbackAgent).length ?? 0;
      const mode = result.runtimeStrategy?.mode ?? "real_first_with_fallback";
      const ok = result.outcome === "SUCCESS";
      const baseText =
        result.outcome === "SUCCESS"
          ? t("agents.auditDone")
          : result.outcome === "PARTIAL_SUCCESS"
            ? t("agents.auditPartial")
            : t("agents.auditFailed");
      setBanner({
        kind: ok ? "ok" : "error",
        text: `${baseText} ${t("agents.auditRunStats", {
          completed: completedCount,
          skipped: skippedCount,
          unavailable: unavailableCount,
          fallback: fallbackCount,
          failed: failedCount,
          mode,
        })}`,
      });
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setBanner({ kind: "error", text: tError(code, msg) });
    } finally {
      setAuditing(false);
    }
  }, [auditing, generating, caseId, refreshAgents, t, tError]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // "Generate report" from the header: build + render, then surface the result.
  const handleHeaderGenerate = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    setBanner(null);
    try {
      const generated = await generateReport(caseId);
      setReport(generated);
      const rendered = await renderReport(caseId);
      setReport({ ...generated, ...rendered });
      setBanner({
        kind: "ok",
        text: t("report.generatedShort", { version: rendered.version }),
      });
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setBanner({ kind: "error", text: tError(code, msg) });
    } finally {
      setGenerating(false);
    }
  }, [caseId, generating, t, tError]);

  if (state.kind === "loading") {
    return (
      <Card>
        <Loading />
      </Card>
    );
  }

  if (state.kind === "disabled") {
    return (
      <Card>
        <Notice>{t("cases.moduleDisabled")}</Notice>
      </Card>
    );
  }

  if (state.kind === "notFound") {
    return (
      <Card>
        <EmptyState title={t("cases.notFoundTitle")} hint={t("cases.notFoundHint")} />
        <div style={{ marginTop: 12 }}>
          <Link className="dp-btn" href="/admin/digital-profile">
            ← {t("common.back")}
          </Link>
        </div>
      </Card>
    );
  }

  if (state.kind === "error") {
    return (
      <Card>
        <div className="dp-stack">
          <ErrorBox>{state.message}</ErrorBox>
          <div>
            <button className="dp-btn" onClick={() => void loadAll()}>
              {t("common.retry")}
            </button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="dp-stack">
      <Card>
        <CaseHeader
          caseDetail={state.caseDetail}
          onGenerate={handleHeaderGenerate}
          generating={generating}
          onRunUnifiedCollection={handleRunUnifiedCollection}
          onRecoverUnifiedCollection={handleRecoverUnifiedCollection}
          onRetrySuggestions={handleRetrySuggestions}
          onPaidRecollection={handlePaidRecollection}
          auditing={auditing}
          recovering={recovering}
          unifiedJob={unifiedJob}
        />
      </Card>

      {banner ? (
        <div>
          {banner.kind === "ok" ? (
            <SuccessBox>{banner.text}</SuccessBox>
          ) : (
            <ErrorBox>{banner.text}</ErrorBox>
          )}
        </div>
      ) : null}

      {isAdmin ? (
        <Card>
          <OrionV2ReportPanel caseId={state.caseDetail.id} />
        </Card>
      ) : null}

      {isAdmin ? (
        <Card>
          <OrionClientStoryboardReportPanel caseId={state.caseDetail.id} />
        </Card>
      ) : null}

      {can("evidence.viewRaw") ? (
        <Card>
          <div className="dp-stack" style={{ gap: 8 }}>
            <strong>ORION Golden — ручная проверка</strong>
            <p className="dp-muted" style={{ margin: 0 }}>
              Сначала подготовьте артефакты (очередь review), затем откройте manual review и сгенерируйте полный ORION Audit.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {can("risk.review") ? (
                <button
                  type="button"
                  className="dp-btn dp-btn-primary"
                  disabled={prepareBusy}
                  onClick={() => {
                    void (async () => {
                      setPrepareBusy(true);
                      setBanner(null);
                      try {
                        const { job } = await getUnifiedOrionCollectionStatus(caseId);
                        const jobId = job?.unifiedJobId ?? "";
                        if (!jobId) {
                          setBanner({
                            kind: "error",
                            text: "Сначала запустите единый аудит ORION — canonical prepare работает только по job-scoped артефактам.",
                          });
                          return;
                        }
                        let result = await prepareOrionGoldenArtifacts(caseId, jobId);
                        setPrepareStatus(result);
                        setBanner({
                          kind: "ok",
                          text: "Canonical prepare запущен в фоне. Обычно несколько минут.",
                        });
                        for (let i = 0; i < 90; i += 1) {
                          if (result.status === "completed" || result.status === "failed") break;
                          await new Promise((r) => setTimeout(r, 5000));
                          result = await getOrionGoldenPrepareStatus(caseId);
                          setPrepareStatus(result);
                        }
                        setBanner({
                          kind: result.ok ? "ok" : "error",
                          text: result.ok
                            ? `Отчёт собран (${result.pageCount} стр.).`
                            : result.warnings[0] ||
                              `Подготовка не завершена (${result.verdict ?? result.status})`,
                        });
                      } catch (err) {
                        const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
                        const msg = err instanceof Error ? err.message : undefined;
                        setBanner({ kind: "error", text: tError(code, msg) });
                      } finally {
                        setPrepareBusy(false);
                      }
                    })();
                  }}
                >
                  {prepareBusy ? "Подготовка…" : "Подготовить ORION Golden / очередь review"}
                </button>
              ) : null}
              <Link className="dp-btn" href={`/admin/digital-profile/${state.caseDetail.id}/orion-golden/manual-review`}>
                Открыть manual review
              </Link>
              <Link
                className="dp-btn dp-btn-primary"
                href={`/admin/digital-profile/${state.caseDetail.id}/orion-golden/manual-review#arsenkin-tools`}
                data-testid="case-arsenkin-audit-link"
              >
                Запустить аудит с Arsenkin
              </Link>
            </div>
            <p className="dp-muted" style={{ margin: 0, fontSize: 13 }}>
              «Запустить аудит с Arsenkin» открывает панель API-сбора. Кнопка «Подготовить ORION Golden»
              не запускает платный Arsenkin.
            </p>
            {prepareStatus ? (
              <p className="dp-muted" style={{ margin: 0 }}>
                Статус: {prepareStatus.status}
                {prepareStatus.queueReady ? ` · отчёт готов (${prepareStatus.pageCount} стр.)` : ""}
                {prepareStatus.verdict ? ` · ${prepareStatus.verdict}` : ""}
              </p>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card>
        <CaseTabs
          caseDetail={state.caseDetail}
          evidence={state.evidence}
          surfaces={surfaces}
          report={report}
          agents={agents}
          agentRuns={agentRuns}
          auditing={auditing}
          lastFullAuditSummary={lastFullAuditSummary}
          onRunFullAudit={handleRunUnifiedCollection}
          onAgentsChanged={() => void refreshAgents()}
          onEvidenceChanged={() => void refreshEvidence()}
          onSurfacesChanged={() => void refreshSurfaces()}
          onReportChange={setReport}
        />
      </Card>
    </div>
  );
}
