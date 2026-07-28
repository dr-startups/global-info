"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  DigitalProfileApiError,
  getCase,
  getEvidence,
  listAgentRuns,
  listAgents,
  listSearchSurfaces,
  runFullAudit,
  prepareOrionGoldenArtifacts,
  getOrionGoldenPrepareStatus,
  startUnifiedOrionCollection,
  recoverUnifiedOrionCollection,
  rebuildUnifiedReport,
  retryUnifiedGptCopy,
  retryUnifiedEnrichmentSuggestionsTask,
  getUnifiedOrionCollectionStatus,
  type AgentInfo,
  type AgentRun,
  type CaseDetail,
  type CaseEvidence,
  type FullAuditRunSummaryItem,
  type OrionGoldenPrepareSummary,
  type SearchSurfaceItem,
  type UnifiedCollectionJobStatus,
} from "./api";
import {
  Card,
  EmptyState,
  ErrorBox,
  Loading,
  Notice,
  SoftRenderBoundary,
  SuccessBox,
} from "./components";
import { CaseHeader } from "./CaseHeader";
import { CaseTabs } from "./CaseTabs";
import { SubjectProfilePanel } from "./SubjectProfilePanel";
import { ReportQualityPanel } from "./ReportQualityPanel";
import { useDigitalProfileI18n } from "./i18n-provider";
import { useDpAuth } from "./auth-provider";
import {
  buildSuggestionsTargetedRetryBody,
  createSingleFlightGuard,
  isAcceptedSuggestionsRetryResult,
  isSuggestionsTargetedRetryState,
  shouldBlockFullAuditCta,
} from "./unified-suggestions-retry-ui";
import {
  isUnifiedRunTerminal,
  nextFollowDelayMs,
  shouldFollowUnifiedRun,
} from "./unified-run-follow";

type LoadState =
  | { kind: "loading" }
  | { kind: "disabled" }
  | { kind: "notFound" }
  | { kind: "error"; message: string }
  | { kind: "ready"; caseDetail: CaseDetail; evidence: CaseEvidence };

export function CaseDetailView({
  caseId,
  legacyReportUi = false,
  manualAgentRun = false,
}: {
  caseId: string;
  /** REMEDIATION §8.1 — legacy v1/v2/storyboard/Golden prepare panels. */
  legacyReportUi?: boolean;
  /** Режим отладки: ручной запуск отдельного агента (шаг 11.2, пункт 2). */
  manualAgentRun?: boolean;
}) {
  const { t, tError } = useDigitalProfileI18n();
  const { user, can } = useDpAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
  const [surfaces, setSurfaces] = useState<SearchSurfaceItem[]>([]);
  const [auditing, setAuditing] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [retryingGptCopy, setRetryingGptCopy] = useState(false);
  const [unifiedJob, setUnifiedJob] = useState<UnifiedCollectionJobStatus | null>(null);
  const [banner, setBanner] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [prepareBusy, setPrepareBusy] = useState(false);
  const [prepareStatus, setPrepareStatus] = useState<OrionGoldenPrepareSummary | null>(null);
  const [lastFullAuditSummary, setLastFullAuditSummary] = useState<{
    mode: "legacy_mock_first" | "real_first_with_fallback" | "real_only" | "mock_only";
    items: FullAuditRunSummaryItem[];
  } | null>(null);
  const suggestionsRetryFlightRef = useRef(createSingleFlightGuard());
  const fullAuditBlockedForTabs = useMemo(
    () => shouldBlockFullAuditCta(unifiedJob) || auditing || recovering,
    [unifiedJob, auditing, recovering]
  );

  const loadAll = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const [caseDetail, evidence, agentList, runs, surfaceList, prep, unified] =
        await Promise.all([
          getCase(caseId),
          getEvidence(caseId),
          listAgents(caseId),
          listAgentRuns(caseId),
          listSearchSurfaces(caseId),
          getOrionGoldenPrepareStatus(caseId).catch(() => null),
          getUnifiedOrionCollectionStatus(caseId).catch(() => ({ job: null })),
        ]);
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

  const announceTerminalRun = useCallback(
    (job: UnifiedCollectionJobStatus) => {
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
    },
    [t]
  );

  /*
   * Страница следит за живым прогоном сама — до конца прогона, а не минуту.
   *
   * Здесь стоял цикл на 120 оборотов по 500 мс: ровно шестьдесят секунд, после
   * чего он молча заканчивался. Прогон идёт около двадцати минут, и всё
   * оставшееся время шапка показывала снимок первой минуты — «Этап: Базовый
   * сбор», «Arsenkin scheduled 0/5». Наблюдалось на боевом прогоне 28.07.
   *
   * Условие слежения — состояние прогона, а не нажатие кнопки: прогон, начатый
   * в другой вкладке или до перезагрузки страницы, такой же живой. Срок
   * следующего вопроса называет сам прогон (`nextPollAt` / `autoResumeAt`) —
   * раньше него новостей быть не может, и спрашивать чаще незачем.
   */
  const followedTerminalRef = useRef<string | null>(null);

  useEffect(() => {
    if (!shouldFollowUnifiedRun(unifiedJob)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const { job } = await getUnifiedOrionCollectionStatus(caseId);
        if (cancelled || !job) return;
        setUnifiedJob(job);
        if (isUnifiedRunTerminal(job)) {
          // Итог объявляется один раз на прогон: иначе перерисовка вернула бы
          // баннер, который пользователь уже закрыл.
          const key = job.unifiedJobId || job.jobId;
          if (followedTerminalRef.current !== key) {
            followedTerminalRef.current = key;
            await refreshAgents();
            if (!cancelled) announceTerminalRun(job);
          }
          return;
        }
        timer = setTimeout(() => void tick(), nextFollowDelayMs(job));
      } catch {
        // Сбой одного запроса статуса не должен снимать слежение: прогон идёт
        // на сервере независимо от того, ответила ли нам сеть сию секунду.
        if (!cancelled) timer = setTimeout(() => void tick(), nextFollowDelayMs(unifiedJob));
      }
    };

    timer = setTimeout(() => void tick(), nextFollowDelayMs(unifiedJob));
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [announceTerminalRun, caseId, refreshAgents, unifiedJob]);

  const handleRunUnifiedCollection = useCallback(async () => {
    if (auditing || recovering) return;
    if (isSuggestionsTargetedRetryState(unifiedJob)) {
      setBanner({
        kind: "error",
        text: t("unified.blockedBySuggestions"),
      });
      return;
    }
    if (unifiedJob?.recoveryAllowed) {
      setBanner({
        kind: "error",
        text: t("unified.blockedByRecoverable", { jobId: unifiedJob.jobId }),
      });
      return;
    }
    if (unifiedJob?.fullAuditBlocked || unifiedJob?.paidRecollectionRequired) {
      setBanner({
        kind: "error",
        text: t("unified.blockedByPreserved"),
      });
      return;
    }
    setAuditing(true);
    setBanner(null);
    try {
      await startUnifiedOrionCollection(caseId);
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
    recovering,
    caseId,
    tError,
    unifiedJob,
  ]);

  const handlePaidRecollection = useCallback(async () => {
    if (auditing || recovering) return;
    const ok = window.confirm(t("unified.paidRecollectionConfirm"));
    if (!ok) return;
    setAuditing(true);
    setBanner(null);
    try {
      await startUnifiedOrionCollection(caseId, { confirmPaidRecollection: true });
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setBanner({ kind: "error", text: tError(code, msg) });
    } finally {
      setAuditing(false);
      const { job } = await getUnifiedOrionCollectionStatus(caseId).catch(() => ({ job: null }));
      if (job) setUnifiedJob(job);
    }
  }, [auditing, recovering, caseId, tError]);

  const handleRecoverUnifiedCollection = useCallback(async () => {
    if (auditing || recovering) return;
    if (isSuggestionsTargetedRetryState(unifiedJob)) {
      setBanner({
        kind: "error",
        text: t("unified.recoveryHiddenBySuggestions"),
      });
      return;
    }
    const jobId = unifiedJob?.jobId;
    if (!jobId || !unifiedJob?.recoveryAllowed) {
      setBanner({
        kind: "error",
        text: t("unified.recoveryUnavailable", {
          reason: unifiedJob?.recoveryBlockerReason ? ` (${unifiedJob.recoveryBlockerReason})` : "",
        }),
      });
      return;
    }
    const renderResume =
      unifiedJob.resumeCheckpoint === "RENDER" ||
      unifiedJob.recoveryReason === "RENDER_RESUME" ||
      unifiedJob.lastErrorCode === "RENDER_FAILED";
    const assemblyResume =
      unifiedJob.recoveryReason === "ASSEMBLY_RESUME" ||
      unifiedJob.lastErrorCode === "ASSEMBLY_FAILED" ||
      unifiedJob.lastErrorCode === "REQUIRED_SECTION_FAILED";
    const ingestResume =
      unifiedJob.resumeCheckpoint === "ARSENKIN_RESULT_INGEST" ||
      unifiedJob.recoveryReason === "ARSENKIN_INGEST_RESUME";
    const ok = window.confirm(
      renderResume
        ? t("unified.confirmResumeRender")
        : assemblyResume
          ? t("unified.confirmResumeAssembly")
          : ingestResume
            ? t("unified.confirmResumeIngest")
            : t("unified.confirmResumeArsenkin")
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
    recovering,
    caseId,
    unifiedJob,
    tError,
  ]);

  const handleRebuildReport = useCallback(async () => {
    if (auditing || recovering || rebuilding || retryingGptCopy) return;
    const jobId = unifiedJob?.unifiedJobId || unifiedJob?.jobId;
    if (!jobId || !unifiedJob?.rebuildAllowed) {
      setBanner({
        kind: "error",
        text: t("unified.rebuildUnavailable", {
          reason: unifiedJob?.rebuildBlockerReason ? ` (${unifiedJob.rebuildBlockerReason})` : "",
        }),
      });
      return;
    }
    const ok = window.confirm(t("unified.rebuildConfirm"));
    if (!ok) return;
    setRebuilding(true);
    setBanner(null);
    try {
      const result = await rebuildUnifiedReport(caseId, jobId);
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
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setBanner({ kind: "error", text: tError(code, msg) });
    } finally {
      setRebuilding(false);
      const { job } = await getUnifiedOrionCollectionStatus(caseId).catch(() => ({ job: null }));
      if (job) setUnifiedJob(job);
    }
  }, [
    auditing,
    recovering,
    rebuilding,
    retryingGptCopy,
    caseId,
    unifiedJob,
    tError,
  ]);

  const handleRetryGptCopy = useCallback(async () => {
    if (auditing || recovering || rebuilding || retryingGptCopy) return;
    const jobId = unifiedJob?.unifiedJobId || unifiedJob?.jobId;
    if (!jobId || !unifiedJob?.gptCopyRetryAllowed) {
      setBanner({
        kind: "error",
        text: t("unified.gptRetryUnavailable", {
          reason: unifiedJob?.gptCopyRetryBlockerReason
            ? ` (${unifiedJob.gptCopyRetryBlockerReason})`
            : "",
        }),
      });
      return;
    }
    const ok = window.confirm(t("unified.gptRetryConfirm"));
    if (!ok) return;
    setRetryingGptCopy(true);
    setBanner(null);
    try {
      const result = await retryUnifiedGptCopy(caseId, jobId);
      setUnifiedJob((prev) =>
        prev
          ? {
              ...prev,
              jobId: result.jobId,
              unifiedJobId: result.unifiedJobId,
              stage: result.stage,
              status: result.status,
              resumeCheckpoint: result.resumeCheckpoint,
            }
          : prev
      );
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setBanner({ kind: "error", text: tError(code, msg) });
    } finally {
      setRetryingGptCopy(false);
      const { job } = await getUnifiedOrionCollectionStatus(caseId).catch(() => ({ job: null }));
      if (job) setUnifiedJob(job);
    }
  }, [
    auditing,
    recovering,
    rebuilding,
    retryingGptCopy,
    caseId,
    unifiedJob,
    tError,
  ]);

  const handleRetrySuggestions = useCallback(async () => {
    if (auditing || recovering) return;
    if (!suggestionsRetryFlightRef.current.tryEnter()) return;
    const jobId = unifiedJob?.jobId;
    const enrichmentRunId = unifiedJob?.suggestionsEnrichmentRunId;
    if (!jobId || !enrichmentRunId || !isSuggestionsTargetedRetryState(unifiedJob)) {
      suggestionsRetryFlightRef.current.leave();
      setBanner({
        kind: "error",
        text: t("unified.suggestionsRetryUnavailable"),
      });
      return;
    }
    const ok = window.confirm(t("unified.retrySuggestionsConfirm"));
    if (!ok) {
      suggestionsRetryFlightRef.current.leave();
      return;
    }
    setRecovering(true);
    setBanner(null);
    try {
      const body = buildSuggestionsTargetedRetryBody({
        jobId,
        enrichmentRunId,
        confirmPaidEnrichmentRetry: true,
      });
      const result = await retryUnifiedEnrichmentSuggestionsTask(caseId, body);
      if (!isAcceptedSuggestionsRetryResult(result)) {
        setBanner({
          kind: "error",
          text: t("unified.suggestionsRetryNoTaskId"),
        });
        return;
      }
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
          ? t("unified.suggestionsReused", { taskId: result.externalTaskId })
          : t("unified.suggestionsSubmitted", { taskId: result.externalTaskId }),
      });
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      // CONFLICT must surface the server code/message (not the generic i18n mask).
      setBanner({ kind: "error", text: tError(code, msg) });
    } finally {
      suggestionsRetryFlightRef.current.leave();
      setRecovering(false);
      const { job } = await getUnifiedOrionCollectionStatus(caseId).catch(() => ({ job: null }));
      if (job) setUnifiedJob(job);
    }
  }, [
    auditing,
    recovering,
    caseId,
    unifiedJob,
    tError,
  ]);

  const handleRunAudit = useCallback(async () => {
    // Admin/diagnostic path only — primary CTA is unified collection.
    if (auditing) return;
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
  }, [auditing, caseId, refreshAgents, t, tError]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

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
          onRunUnifiedCollection={handleRunUnifiedCollection}
          onRecoverUnifiedCollection={handleRecoverUnifiedCollection}
          onRetrySuggestions={handleRetrySuggestions}
          onPaidRecollection={handlePaidRecollection}
          onRebuildReport={handleRebuildReport}
          auditing={auditing}
          recovering={recovering}
          rebuilding={rebuilding}
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

      {can("case.view") ? (
        <Card>
          <SubjectProfilePanel caseId={state.caseDetail.id} />
        </Card>
      ) : null}

      {unifiedJob?.reportQuality ||
      (unifiedJob?.warnings ?? []).some((w) => w.startsWith("offline-enrichment-mode")) ? (
        <Card>
          <SoftRenderBoundary>
            <ReportQualityPanel
              quality={unifiedJob?.reportQuality}
              jobWarnings={unifiedJob?.warnings}
              caseId={caseId}
              jobId={unifiedJob?.unifiedJobId ?? unifiedJob?.jobId}
              onRetryGptCopy={handleRetryGptCopy}
              retryingGptCopy={retryingGptCopy}
              gptCopyRetryAllowed={Boolean(unifiedJob?.gptCopyRetryAllowed)}
            />
          </SoftRenderBoundary>
        </Card>
      ) : null}

      {legacyReportUi && can("evidence.viewRaw") ? (
        <Card>
          <div className="dp-stack" style={{ gap: 8 }}>
            <strong>{t("unified.goldenTitle")}</strong>
            <p className="dp-muted" style={{ margin: 0 }}>
              {t("unified.goldenHint")}
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
                            text: t("unified.goldenNeedsRun"),
                          });
                          return;
                        }
                        let result = await prepareOrionGoldenArtifacts(caseId, jobId);
                        setPrepareStatus(result);
                        setBanner({
                          kind: "ok",
                          text: t("unified.goldenStarted"),
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
                            ? t("unified.goldenDone", { pages: result.pageCount ?? 0 })
                            : result.warnings[0] ||
                              t("unified.goldenNotFinished", {
                                verdict: String(result.verdict ?? result.status),
                              }),
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
                  {prepareBusy ? t("unified.goldenPreparing") : t("unified.goldenPrepare")}
                </button>
              ) : null}
              <Link className="dp-btn" href={`/admin/digital-profile/${state.caseDetail.id}/orion-golden/manual-review`}>
                {t("unified.goldenOpenReview")}
              </Link>
              <Link
                className="dp-btn dp-btn-primary"
                href={`/admin/digital-profile/${state.caseDetail.id}/orion-golden/manual-review#arsenkin-tools`}
                data-testid="case-arsenkin-audit-link"
              >
                {t("unified.goldenRunArsenkin")}
              </Link>
            </div>
            <p className="dp-muted" style={{ margin: 0, fontSize: 13 }}>
              {t("unified.goldenFootnote")}
            </p>
            {prepareStatus ? (
              <p className="dp-muted" style={{ margin: 0 }}>
                {t("unified.goldenStatus")}: {prepareStatus.status}
                {prepareStatus.queueReady
                  ? ` · ${t("unified.goldenQueueReady", { pages: prepareStatus.pageCount ?? 0 })}`
                  : ""}
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
          agents={agents}
          agentRuns={agentRuns}
          auditing={auditing}
          unifiedJob={unifiedJob}
          fullAuditBlocked={fullAuditBlockedForTabs}
          lastFullAuditSummary={lastFullAuditSummary}
          manualAgentRun={manualAgentRun}
          onRunFullAudit={handleRunUnifiedCollection}
          onAgentsChanged={() => void refreshAgents()}
          onEvidenceChanged={() => void refreshEvidence()}
          onSurfacesChanged={() => void refreshSurfaces()}
        />
      </Card>
    </div>
  );
}
