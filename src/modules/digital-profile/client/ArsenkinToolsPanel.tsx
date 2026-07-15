"use client";

/**
 * Arsenkin Tools UI panel — API collector, not Playwright LIVE SERP.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DigitalProfileApiError,
  executeArsenkinRun,
  generateOrionClassicAuditReport,
  getOrionClassicDiagnosticsBundleUrl,
  getArsenkinStatus,
  planArsenkinRun,
  prepareArsenkinRun,
  recoverArsenkinConfirmNotCreated,
  recoverArsenkinContinueStage1,
  recoverArsenkinLinkExisting,
  recoverArsenkinReconcileDone,
  recoverArsenkinRetryUnconfirmed,
  refreshArsenkinDbReadiness,
  startArsenkinFullAudit,
  cancelArsenkinFullAudit,
  syncArsenkinRun,
  type ArsenkinUiPlanDto,
  type ArsenkinSurfaceMatrixRow,
  type ArsenkinUiStage,
  type ArsenkinUiStatusDto,
} from "./api";
import { Badge, Card, ErrorBox, Notice, SuccessBox, WarningBox } from "./components";

type WorkflowMode = "canary" | "first36";

function stageForMode(mode: WorkflowMode, status: ArsenkinUiStatusDto | null): ArsenkinUiStage {
  if (mode === "canary") return "SUGGEST_RU_CANARY";
  if (status?.stage === "FIRST36_STAGE1" && (status.status === "SYNC_READY" || status.status === "READY_TO_TRANSFER")) {
    return "FIRST36_STAGE1";
  }
  if (
    status?.stage === "FIRST36_STAGE1" &&
    (status.status === "STAGE_DONE" ||
      status.status === "SYNCED" ||
      status.status === "TRANSFERRED" ||
      status.status === "REPORT_BOUND" ||
      status.verdict === "DONE")
  ) {
    return "FIRST36_STAGE2";
  }
  if (status?.stage === "FIRST36_STAGE2") return "FIRST36_STAGE2";
  return "FIRST36_STAGE1";
}

function shortDigest(d: string | null | undefined): string {
  if (!d) return "—";
  return d.length <= 16 ? d : `${d.slice(0, 8)}…${d.slice(-6)}`;
}

function statusTone(
  s: ArsenkinUiStatusDto["status"]
): "ok" | "warn" | "neutral" | "danger" {
  if (
    s === "SYNCED" ||
    s === "TRANSFERRED" ||
    s === "REPORT_BOUND" ||
    s === "STAGE_DONE" ||
    s === "SYNC_READY" ||
    s === "READY_TO_TRANSFER"
  ) {
    return "ok";
  }
  if (s === "EXECUTING" || s === "PLAN_READY" || s === "PREPARED" || s === "TRANSFERRING" || s === "READINESS_RUNNING") {
    return "warn";
  }
  if (
    s === "FAILED" ||
    s === "TRANSFER_FAILED" ||
    s === "MANUAL_INTERVENTION_REQUIRED" ||
    s === "BLOCKED"
  ) {
    return "danger";
  }
  return "neutral";
}

function statusLabelRu(s: ArsenkinUiStatusDto["status"]): string {
  const map: Record<ArsenkinUiStatusDto["status"], string> = {
    NOT_CONFIGURED: "Не подключён",
    READINESS_RUNNING: "Проверка БД…",
    READY_TO_PREPARE: "Готов к подготовке",
    PREPARED: "Подготовлен",
    PLAN_READY: "План готов",
    EXECUTING: "Выполняется",
    STAGE_DONE: "Стадия завершена",
    SYNC_READY: "Готов к передаче в ORION",
    READY_TO_TRANSFER: "Готов к передаче в ORION",
    TRANSFERRING: "Передача в ORION…",
    SYNCED: "Результаты переданы",
    TRANSFERRED: "Результаты переданы",
    TRANSFER_FAILED: "Передача не удалась",
    REPORT_BOUND: "Отчёт привязан к Arsenkin",
    BLOCKED: "Заблокирован",
    FAILED: "Ошибка",
    MANUAL_INTERVENTION_REQUIRED: "Требуется ручное вмешательство",
  };
  return map[s] ?? s;
}

function matrixTone(status: ArsenkinSurfaceMatrixRow["status"]): "ok" | "warn" | "neutral" | "danger" {
  if (status === "MEASURED" || status === "DONE" || status === "NO RESULTS") return "ok";
  if (status === "PLANNED" || status === "RUNNING") return "warn";
  if (
    status === "FAILED" ||
    status === "FAILED PARSE" ||
    status === "SUBMIT UNKNOWN" ||
    status === "RESULT FETCH FAILED"
  ) {
    return "danger";
  }
  return "neutral";
}

export function ArsenkinToolsPanel(props: {
  caseId: string;
  reportRunId: string | null;
  canDecide: boolean;
}) {
  const { caseId, reportRunId, canDecide } = props;
  const [mode, setMode] = useState<WorkflowMode>("canary");
  const [status, setStatus] = useState<ArsenkinUiStatusDto | null>(null);
  const [plan, setPlan] = useState<ArsenkinUiPlanDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmedPaid, setConfirmedPaid] = useState(false);
  const [executeLocked, setExecuteLocked] = useState(false);
  const [linkTaskId, setLinkTaskId] = useState("");
  const [linkExternalId, setLinkExternalId] = useState("");
  const [confirmReason, setConfirmReason] = useState(
    "provider_queue_and_results_checked_no_task_found"
  );
  const [confirmTaskId, setConfirmTaskId] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const executeInFlight = useRef(false);

  const stage = stageForMode(mode, status);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await getArsenkinStatus(caseId, {
        reportRunId: reportRunId ?? undefined,
        stage,
      });
      setStatus(s);
      setError(null);
      const orchState = String(s.orchestration?.state ?? "");
      const orchTerminal = ["COMPLETED", "COMPLETED_PARTIAL", "FAILED_TERMINAL", "CANCELLED"].includes(
        orchState
      );
      const autoRepairable =
        Boolean(s.sourceBindingAutoRepairable) ||
        s.orchestration?.nextStep === "auto-repair-source" ||
        s.orchestration?.nextStep === "bounded-resume";
      if (orchState && (!orchTerminal || autoRepairable) && (orchState !== "FAILED_RETRYABLE" || autoRepairable)) {
        // Keep polling while durable full-audit job is active or auto-repairing.
        return s;
      }
      if (
        s.status === "STAGE_DONE" ||
        s.status === "SYNC_READY" ||
        s.status === "READY_TO_TRANSFER" ||
        s.status === "SYNCED" ||
        s.status === "TRANSFERRED" ||
        s.status === "REPORT_BOUND" ||
        s.status === "TRANSFER_FAILED" ||
        s.status === "FAILED" ||
        s.status === "MANUAL_INTERVENTION_REQUIRED" ||
        (s.status === "BLOCKED" && s.readinessCode !== "READINESS_RUNNING")
      ) {
        if (!orchState || orchTerminal) {
          stopPolling();
          setExecuteLocked(false);
        }
      }
      return s;
    } catch (e) {
      const msg =
        e instanceof DigitalProfileApiError ? e.message : "Не удалось получить статус Arsenkin";
      setError(msg);
      // Do not stop polling on transient network errors — resume next tick.
      return null;
    }
  }, [caseId, reportRunId, stage, stopPolling]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(() => {
      void refresh();
    }, 3000);
  }, [refresh, stopPolling]);

  useEffect(() => {
    if (status?.status === "READINESS_RUNNING") {
      startPolling();
      return () => stopPolling();
    }
    return undefined;
  }, [status?.status, startPolling, stopPolling]);

  useEffect(() => {
    const orchState = String(status?.orchestration?.state ?? "");
    const orchActiveLocal =
      Boolean(orchState) &&
      !["COMPLETED", "COMPLETED_PARTIAL", "FAILED_TERMINAL", "CANCELLED"].includes(orchState);
    if (orchActiveLocal) {
      startPolling();
      return () => stopPolling();
    }
    return undefined;
  }, [status?.orchestration?.state, startPolling, stopPolling]);

  useEffect(() => {
    const orch = status?.orchestration;
    if (!orch) return;
    if (
      orch.jobWorkflowType === "FIRST36_FULL" ||
      String(orch.jobReportRunId ?? "").startsWith("orion-arsenkin-first36-full-")
    ) {
      setMode("first36");
    }
  }, [
    status?.orchestration?.jobId,
    status?.orchestration?.jobWorkflowType,
    status?.orchestration?.jobReportRunId,
  ]);

  const onRefreshReadiness = () => {
    void runAction(async () => {
      const s = await refreshArsenkinDbReadiness(caseId, {
        reportRunId: reportRunId ?? undefined,
        stage,
      });
      setStatus(s);
      setBanner("Проверка готовности БД запущена.");
    });
  };

  const runAction = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setBanner(null);
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof DigitalProfileApiError ? e.message : "Ошибка Arsenkin";
      setError(msg);
      if (/digest|устарел|stale/i.test(msg)) {
        setConfirmedPaid(false);
        setConfirmOpen(false);
        setPlan(null);
        setBanner("План изменился. Сформируйте план заново.");
      }
    } finally {
      setBusy(false);
    }
  };

  const onPrepare = () => {
    if (!reportRunId) return;
    void runAction(async () => {
      const s = await prepareArsenkinRun(caseId, { reportRunId, stage });
      setStatus(s);
      setBanner(
        s.arsenkinReportRunId && s.sourceReportRunId && s.arsenkinReportRunId !== s.sourceReportRunId
          ? `Arsenkin подготовлен. Новый Arsenkin reportRunId: ${s.arsenkinReportRunId}`
          : "Arsenkin подготовлен (без сетевых вызовов)."
      );
    });
  };

  const activeReportRunId = status?.arsenkinReportRunId ?? status?.reportRunId ?? reportRunId;

  const onPlan = () => {
    if (!reportRunId) return;
    void runAction(async () => {
      const p = await planArsenkinRun(caseId, {
        reportRunId: activeReportRunId ?? reportRunId,
        stage,
      });
      setPlan(p);
      setStatus(p);
      setConfirmedPaid(false);
      setBanner("План сформирован — списания нет.");
    });
  };

  const onExecuteConfirmed = () => {
    const runId = activeReportRunId ?? reportRunId;
    if (!runId || !plan?.digest || !confirmedPaid) return;
    if (executeInFlight.current || executeLocked) return;
    executeInFlight.current = true;
    setExecuteLocked(true);
    setConfirmOpen(false);
    void runAction(async () => {
      startPolling();
      const s = await executeArsenkinRun(caseId, {
        reportRunId: runId,
        stage,
        confirmPlanDigest: plan.digest,
        confirmed: true,
      });
      setStatus(s);
      if (s.status === "EXECUTING" || s.status === "PREPARED") {
        startPolling();
      } else {
        stopPolling();
        setExecuteLocked(false);
      }
      if (s.status === "STAGE_DONE" || s.status === "SYNC_READY") {
        setBanner("Стадия Arsenkin завершена.");
      }
    }).finally(() => {
      executeInFlight.current = false;
    });
  };

  const onSync = () => {
    const runId = activeReportRunId ?? reportRunId;
    if (!runId) return;
    void runAction(async () => {
      const s = await syncArsenkinRun(caseId, { reportRunId: runId, stage });
      setStatus(s);
      const transferred =
        s.status === "TRANSFERRED" ||
        s.status === "REPORT_BOUND" ||
        s.status === "SYNCED" ||
        (s.synced &&
          (s.transferStatus === "TRANSFERRED" || s.transferStatus === "REPORT_BOUND"));
      if (transferred) {
        setBanner(
          [
            "Результаты переданы в отчёт.",
            s.effectiveReportRunId
              ? `Effective reportRunId: ${s.effectiveReportRunId}`
              : null,
            `ProviderTasks=${s.providerTaskCount}, observations=${s.observationCount}, coverage=${s.coverageCount}.`,
            s.transferredAt ? `Передано: ${s.transferredAt}` : null,
            "Отчёт будет собран из данных Arsenkin.",
          ]
            .filter(Boolean)
            .join(" ")
        );
      } else if (s.status === "TRANSFER_FAILED") {
        setBanner(s.lastError ?? "Передача в ORION не удалась.");
      } else {
        setBanner("Передача в ORION не завершена — binding/client content не сохранены.");
      }
    });
  };

  const onRebuildReport = () => {
    void runAction(async () => {
      await generateOrionClassicAuditReport(caseId, { regenerateContent: false });
      setBanner("Пересборка отчёта запущена.");
    });
  };

  const onDownloadDiagnostics = () => {
    const url = getOrionClassicDiagnosticsBundleUrl(caseId);
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const onReconcileDone = () => {
    const runId = activeReportRunId ?? reportRunId;
    if (!runId) return;
    void runAction(async () => {
      const s = await recoverArsenkinReconcileDone(caseId, { reportRunId: runId, stage });
      setStatus(s);
      setBanner("Повторное получение результатов DONE-задач завершено.");
    });
  };

  const onConfirmNotCreated = () => {
    const runId = activeReportRunId ?? reportRunId;
    const providerTaskId = confirmTaskId || status?.recovery?.submitUnknown[0]?.providerTaskId;
    if (!runId || !providerTaskId || !confirmReason.trim()) return;
    void runAction(async () => {
      const s = await recoverArsenkinConfirmNotCreated(caseId, {
        reportRunId: runId,
        stage,
        providerTaskId,
        reason: confirmReason.trim(),
      });
      setStatus(s);
      setBanner("SUBMIT_UNKNOWN: подтверждено отсутствие задачи у провайдера.");
    });
  };

  const onLinkExisting = () => {
    const runId = activeReportRunId ?? reportRunId;
    const providerTaskId = linkTaskId || status?.recovery?.submitUnknown[0]?.providerTaskId;
    if (!runId || !providerTaskId || !linkExternalId.trim()) return;
    void runAction(async () => {
      const s = await recoverArsenkinLinkExisting(caseId, {
        reportRunId: runId,
        stage,
        providerTaskId,
        externalTaskId: linkExternalId.trim(),
      });
      setStatus(s);
      setBanner(`Привязан существующий Arsenkin task ${linkExternalId.trim()}.`);
      setLinkExternalId("");
    });
  };

  const onRetryUnconfirmed = () => {
    const runId = activeReportRunId ?? reportRunId;
    const providerTaskId =
      status?.recovery?.submitUnknown.find((t) => t.canRetryAfterConfirm)?.providerTaskId ??
      status?.recovery?.submitUnknown[0]?.providerTaskId;
    if (!runId || !providerTaskId) return;
    void runAction(async () => {
      const s = await recoverArsenkinRetryUnconfirmed(caseId, {
        reportRunId: runId,
        stage,
        providerTaskId,
      });
      setStatus(s);
      setBanner("Повторён только неподтверждённый /set (один раз).");
    });
  };

  const onContinueStage1 = () => {
    const runId = activeReportRunId ?? reportRunId;
    const digest = status?.planDigest ?? plan?.digest;
    if (!runId || !digest) return;
    void runAction(async () => {
      const s = await recoverArsenkinContinueStage1(caseId, {
        reportRunId: runId,
        stage,
        confirmPlanDigest: digest,
        confirmed: true,
      });
      setStatus(s);
      setBanner("Stage 1 продолжен после recovery (DONE tasks не дублируются).");
    });
  };

  const orch = status?.orchestration;
  const orchActive =
    Boolean(orch) &&
    !["COMPLETED", "COMPLETED_PARTIAL", "FAILED_TERMINAL", "CANCELLED"].includes(
      String(orch?.state ?? "")
    );
  const orchRetryable = orch?.state === "FAILED_RETRYABLE";
  const orchAutoRepairable =
    Boolean(status?.sourceBindingAutoRepairable) ||
    orch?.nextStep === "auto-repair-source" ||
    orch?.nextStep === "bounded-resume" ||
    orch?.nextStep === "recover-existing-run" ||
    orch?.state === "RECOVERING" ||
    orch?.state === "RUNNING" ||
    String(orch?.lastError ?? "").includes("SOURCE_BINDING_REPAIRABLE") ||
    /уже привязан к source|Стадия FAILED|RESULT_FETCH|SUBMIT_UNKNOWN/i.test(
      String(orch?.lastError ?? "")
    );
  // Staff continue is never required for retryable recovery — hide from primary CTA.
  const showContinueButton = false;

  const onStartFullAudit = () => {
    const runId = activeReportRunId ?? reportRunId;
    if (!runId) return;
    void runAction(async () => {
      // Force Full First36 UI mode immediately — never keep canary DTO as active view.
      setMode("first36");
      setPlan(null);
      startPolling();
      const s = await startArsenkinFullAudit(caseId, {
        reportRunId: runId,
        stage: "FIRST36_STAGE1",
        confirmed: true,
      });
      setStatus(s);
      startPolling();
      setBanner(
        orchRetryable || s.orchestration?.state === "FAILED_RETRYABLE"
          ? "Сбор продолжен."
          : "Полный сбор Arsenkin запущен. Дальше сервер ведёт процесс сам."
      );
    });
  };

  const onCancelFullAudit = () => {
    const runId = activeReportRunId ?? reportRunId;
    if (!runId) return;
    void runAction(async () => {
      const s = await cancelArsenkinFullAudit(caseId, {
        reportRunId: runId,
        stage: "FIRST36_STAGE1",
      });
      setStatus(s);
      stopPolling();
      setBanner("Сбор отменён.");
    });
  };

  const terminalBad =
    status?.status === "FAILED" ||
    status?.status === "MANUAL_INTERVENTION_REQUIRED" ||
    status?.status === "TRANSFER_FAILED";
  const transferComplete =
    status?.synced ||
    status?.status === "SYNCED" ||
    status?.status === "TRANSFERRED" ||
    status?.status === "REPORT_BOUND";
  const canTransferUi =
    status?.canSync ||
    status?.status === "SYNC_READY" ||
    status?.status === "READY_TO_TRANSFER" ||
    status?.status === "STAGE_DONE" ||
    status?.status === "TRANSFER_FAILED";
  const canExecuteUi =
    canDecide &&
    Boolean(plan?.digest) &&
    confirmedPaid &&
    !busy &&
    !executeLocked &&
    !terminalBad &&
    (status?.canExecute || status?.status === "PLAN_READY" || status?.status === "PREPARED");

  return (
    <div id="arsenkin-tools" data-testid="arsenkin-tools-panel">
    <Card>
      <div className="dp-stack" style={{ gap: 10 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <strong>Arsenkin Tools — поисковые API</strong>
          {status ? (
            <Badge tone={statusTone(status.status)}>{statusLabelRu(status.status)}</Badge>
          ) : null}
          {status?.configured ? (
            <Badge tone="ok">подключён</Badge>
          ) : (
            <Badge tone="warn">не подключён</Badge>
          )}
        </div>

        <Notice>
          Arsenkin получает структурированные результаты через API. Это не браузерный LIVE SERP
          capture.
        </Notice>

        <div className="dp-stack" style={{ gap: 6 }}>
          <span className="dp-muted">Режим</span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className={`dp-btn ${mode === "canary" ? "dp-btn-primary" : ""}`}
              disabled={busy || executeLocked}
              onClick={() => {
                setMode("canary");
                setPlan(null);
                setConfirmedPaid(false);
              }}
            >
              Проверочный запуск — 2 запроса
            </button>
            <button
              type="button"
              className={`dp-btn ${mode === "first36" ? "dp-btn-primary" : ""}`}
              disabled={busy || executeLocked}
              onClick={() => {
                setMode("first36");
                setPlan(null);
                setConfirmedPaid(false);
              }}
            >
              Полный сбор First36
            </button>
          </div>
          {mode === "canary" ? (
            <span className="dp-muted">
              SUGGEST_RU_CANARY · Yandex RU + Google RU · preview, не полный First36
            </span>
          ) : (
            <span className="dp-muted">
              FIRST36_FULL · Stage 1 (8) + Stage 2 (4) = 12 поверхностей одним кликом «Запустить
              полный сбор Arsenkin».
            </span>
          )}
        </div>

        {mode === "first36" || status?.requestedWorkflowType === "FIRST36_FULL" || orch ? (
          <Notice>
            <div className="dp-stack" style={{ gap: 4 }}>
              <strong>Режим: Полный сбор First36</strong>
              <div>
                Текущий Full Arsenkin run:{" "}
                <code>
                  {status?.enrichmentReportRunId ??
                    status?.orchestration?.jobReportRunId ??
                    status?.jobReportRunId ??
                    status?.arsenkinReportRunId ??
                    "—"}
                </code>
              </div>
              <div>
                Базовый отчёт ORION:{" "}
                <code>
                  {status?.baseOrionReportRunId ??
                    (status?.sourceOrionReportRunId &&
                    !String(status.sourceOrionReportRunId).startsWith("orion-arsenkin-")
                      ? status.sourceOrionReportRunId
                      : null) ??
                    "—"}
                </code>
              </div>
              {status?.previousEnrichmentReportRunId || status?.previousBindingReportRunId ? (
                <div>
                  Предыдущее обогащение:{" "}
                  <code>
                    {status?.previousEnrichmentReportRunId ?? status?.previousBindingReportRunId}
                  </code>
                </div>
              ) : null}
              <div>Этап: {status?.orchestration?.humanPhase ?? status?.stage ?? "—"}</div>
              <div>
                Поверхности:{" "}
                {status?.orchestration?.terminalSurfaceCount ??
                  status?.terminalSurfaceCount ??
                  status?.orchestration?.surfacesDone ??
                  0}
                /
                {status?.orchestration?.expectedSurfaceCount ??
                  status?.expectedSurfaceCount ??
                  status?.orchestration?.surfacesTotal ??
                  12}
                {status?.orchestration?.stage1TerminalCount != null ? (
                  <span className="dp-muted">
                    {" "}
                    · Stage 1: {status.orchestration.stage1TerminalCount}/8 · Stage 2:{" "}
                    {status.orchestration.stage2TerminalCount ?? 0}/4
                  </span>
                ) : null}
              </div>
              <div>
                Observations:{" "}
                {status?.orchestration?.observationCount ?? status?.observationCount ?? 0}
              </div>
              {orch?.percent != null ? <div>Прогресс: {orch.percent}%</div> : null}
            </div>
          </Notice>
        ) : null}

        <div className="dp-kv">
          <div>
            <span className="dp-muted">Базовый отчёт ORION</span>
            <div>
              <code>
                {status?.baseOrionReportRunId ??
                  (status?.sourceReportRunId &&
                  !String(status.sourceReportRunId).startsWith("orion-arsenkin-")
                    ? status.sourceReportRunId
                    : null) ??
                  "—"}
              </code>
            </div>
          </div>
          <div>
            <span className="dp-muted">Текущий Full Arsenkin run</span>
            <div>
              <code>
                {status?.enrichmentReportRunId ??
                  status?.arsenkinReportRunId ??
                  status?.reportRunId ??
                  "—"}
              </code>
            </div>
          </div>
          <div>
            <span className="dp-muted">Предыдущее обогащение</span>
            <div>
              <code>
                {status?.previousEnrichmentReportRunId ??
                  status?.previousBindingReportRunId ??
                  "—"}
              </code>
            </div>
          </div>
          <div>
            <span className="dp-muted">workflow / stage</span>
            <div>
              {status?.workflow ?? "—"} / {stage}
            </div>
          </div>
          <div>
            <span className="dp-muted">инструменты</span>
            <div>{(status?.tools ?? []).join(", ") || "—"}</div>
          </div>
          <div>
            <span className="dp-muted">задачи / лимиты</span>
            <div>
              {status?.plannedNewTasks ?? plan?.plannedNewTasks ?? "—"} / max{" "}
              {status?.maxNewTasks ?? "—"} · limits{" "}
              {status?.estimatedLimitsTotal ?? plan?.estimatedLimitsTotal ?? "—"} / max{" "}
              {status?.maxEstimatedLimits ?? "—"}
            </div>
          </div>
          <div>
            <span className="dp-muted">ProviderTask / observations / coverage</span>
            <div>
              {status?.providerTaskCount ?? 0} / {status?.observationCount ?? 0} /{" "}
              {status?.coverageCount ?? 0}
            </div>
          </div>
          <div>
            <span className="dp-muted">network calls</span>
            <div>{status?.networkCalls ?? 0}</div>
          </div>
        </div>

        {mode === "first36" && (status?.surfaceMatrix?.length ?? 0) > 0 ? (
          <div className="dp-stack" style={{ gap: 6 }}>
            <span className="dp-muted">Surface matrix</span>
            <div style={{ display: "grid", gap: 6 }}>
              {(status?.surfaceMatrix ?? []).map((cell) => (
                <div
                  key={cell.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    border: "1px solid #e5e7eb",
                    borderRadius: 8,
                    padding: "6px 8px",
                  }}
                >
                  <span>{cell.label}</span>
                  <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <Badge tone={matrixTone(cell.status)}>{cell.status}</Badge>
                    <span className="dp-muted" style={{ fontSize: 12 }}>
                      obs {cell.observationsCount} · tasks {cell.tasksCount}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {(status?.humanMessages?.length || status?.blockers?.length) ? (
          <WarningBox>
            {(status.humanMessages?.length ? status.humanMessages : status.blockers).join(" ")}
          </WarningBox>
        ) : null}

        {error ? <ErrorBox>{error}</ErrorBox> : null}
        {banner ? <SuccessBox>{banner}</SuccessBox> : null}
        {terminalBad ? (
          <ErrorBox>
            Автоповтор запрещён. Статус: {statusLabelRu(status!.status)}
            {status?.lastError ? ` — ${status.lastError}` : ""}
          </ErrorBox>
        ) : null}

        {canDecide && status?.recovery && (
          (status.recovery.submitUnknown.length > 0 ||
            status.recovery.doneZeroObservations.length > 0 ||
            status.recovery.canContinueStage1) ? (
          <details data-testid="arsenkin-recovery-panel">
            <summary className="dp-muted" style={{ cursor: "pointer" }}>
              Техническая диагностика — recovery
            </summary>
          <div
            className="dp-stack"
            style={{ gap: 8, border: "1px solid #f59e0b", borderRadius: 8, padding: 10, marginTop: 8 }}
          >
            <strong>Recovery / reconciliation</strong>
            <span className="dp-muted" style={{ fontSize: 13 }}>
              Не полный перезапуск. Действия безопасны и не создают дубликаты DONE-задач.
            </span>

            {status.recovery.doneZeroObservations.length > 0 ? (
              <div className="dp-stack" style={{ gap: 6 }}>
                <span>
                  DONE без observations:{" "}
                  {status.recovery.doneZeroObservations
                    .map((t) => `${t.toolName}#${t.externalTaskId}`)
                    .join(", ")}
                </span>
                <button
                  type="button"
                  className="dp-btn dp-btn-primary"
                  disabled={busy}
                  onClick={onReconcileDone}
                  data-testid="arsenkin-recover-reconcile-done"
                >
                  Повторно получить результаты DONE-задач
                </button>
              </div>
            ) : null}

            {status.recovery.submitUnknown.map((t) => (
              <div key={t.providerTaskId} className="dp-stack" style={{ gap: 6 }}>
                <strong>SUBMIT_UNKNOWN · {t.toolName}</strong>
                <div className="dp-muted" style={{ fontSize: 12 }}>
                  engine={t.engine ?? "—"} · region={t.region ?? "—"} · query={t.query ?? "—"}
                  <br />
                  requestHash={t.requestHash.slice(0, 16)}… · error={t.errorCode ?? "—"} · http=
                  {t.httpStatus ?? "—"}
                  <br />
                  createdAt={t.createdAt}
                </div>
                {t.canLinkExisting ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <input
                      className="dp-input"
                      placeholder="Arsenkin task ID"
                      value={linkExternalId}
                      onFocus={() => setLinkTaskId(t.providerTaskId)}
                      onChange={(e) => {
                        setLinkTaskId(t.providerTaskId);
                        setLinkExternalId(e.target.value);
                      }}
                      data-testid="arsenkin-recover-link-external-id"
                    />
                    <button
                      type="button"
                      className="dp-btn"
                      disabled={busy || !linkExternalId.trim()}
                      onClick={onLinkExisting}
                      data-testid="arsenkin-recover-link-existing"
                    >
                      Привязать существующий task ID
                    </button>
                  </div>
                ) : null}
                {t.canConfirmNotCreated ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <input
                      className="dp-input"
                      style={{ minWidth: 280 }}
                      value={confirmReason}
                      onFocus={() => setConfirmTaskId(t.providerTaskId)}
                      onChange={(e) => {
                        setConfirmTaskId(t.providerTaskId);
                        setConfirmReason(e.target.value);
                      }}
                      data-testid="arsenkin-recover-confirm-reason"
                    />
                    <button
                      type="button"
                      className="dp-btn"
                      disabled={busy || !confirmReason.trim()}
                      onClick={onConfirmNotCreated}
                      data-testid="arsenkin-recover-confirm-not-created"
                    >
                      Подтвердить: задача не создана
                    </button>
                  </div>
                ) : null}
                {t.canRetryAfterConfirm ? (
                  <button
                    type="button"
                    className="dp-btn dp-btn-primary"
                    disabled={busy}
                    onClick={onRetryUnconfirmed}
                    data-testid="arsenkin-recover-retry-unconfirmed"
                  >
                    Повторить только неподтверждённую задачу
                  </button>
                ) : null}
              </div>
            ))}

            {status.recovery.canContinueStage1 ? (
              <button
                type="button"
                className="dp-btn dp-btn-primary"
                disabled={busy || !(status.planDigest || plan?.digest)}
                onClick={onContinueStage1}
                data-testid="arsenkin-recover-continue-stage1"
              >
                Продолжить Stage 1
              </button>
            ) : null}
          </div>
          </details>
        ) : null)}

        {plan?.requests?.length ? (
          <div className="dp-stack" style={{ gap: 4 }}>
            <span className="dp-muted">План (digest {shortDigest(plan.digest)})</span>
            {plan.requests.map((r) => (
              <div key={r.requestHash} className="dp-muted" style={{ fontSize: 13 }}>
                {r.action} · {r.tool} · {r.engine} {r.region}
                {r.query ? ` · ${r.query.slice(0, 60)}` : ""}
              </div>
            ))}
          </div>
        ) : null}

        {canDecide ? (
          <div className="dp-stack" style={{ gap: 10 }}>
            {orch ? (
              <div
                className="dp-stack"
                style={{ gap: 4, border: "1px solid #e5e7eb", borderRadius: 8, padding: 10 }}
                data-testid="arsenkin-orchestration-progress"
              >
                <strong>{orch.humanPhase}</strong>
                <div className="dp-muted" style={{ fontSize: 13 }}>
                  {orch.percent}% · Stage 1: {orch.stage1TerminalCount ?? 0}/8 · Stage 2:{" "}
                  {orch.stage2TerminalCount ?? 0}/4 · всего {orch.surfacesDone}/{orch.surfacesTotal} ·
                  observations {orch.observationCount}
                </div>
                <div className="dp-muted" style={{ fontSize: 12 }}>
                  Resume: {orch.orchestrationResumeCount ?? orch.attempt ?? 0} · /set{" "}
                  {orch.providerSubmitAttempt ?? 0} · /check {orch.providerCheckAttempt ?? 0} · /get{" "}
                  {orch.providerFetchAttempt ?? 0}
                </div>
                {orch.humanMessage ? (
                  <div style={{ fontSize: 13 }}>{orch.humanMessage}</div>
                ) : null}
                {orch.nextRetryAt ? (
                  <div className="dp-muted" style={{ fontSize: 12 }}>
                    Следующая попытка: {orch.nextRetryAt}
                  </div>
                ) : null}
                {orch.lastError && !orchAutoRepairable ? (
                  <ErrorBox>
                    {/Стадия FAILED|prepare запрещён/i.test(orch.lastError)
                      ? "Arsenkin временно не принял одну задачу. Повтор через несколько секунд. Остальные проверки продолжаются."
                      : orch.lastError}
                  </ErrorBox>
                ) : null}
              </div>
            ) : null}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="dp-btn dp-btn-primary"
                disabled={busy || !reportRunId || orchActive}
                onClick={onStartFullAudit}
                data-testid="arsenkin-start-full-audit"
              >
                {orchActive ? "Сбор выполняется" : "Запустить полный сбор Arsenkin"}
              </button>
              {orchActive ? (
                <button
                  type="button"
                  className="dp-btn"
                  disabled={busy}
                  onClick={onCancelFullAudit}
                  data-testid="arsenkin-cancel-full-audit"
                >
                  Отменить сбор
                </button>
              ) : null}
            </div>

            <details data-testid="arsenkin-tech-diagnostics">
              <summary className="dp-muted" style={{ cursor: "pointer" }}>
                Техническая диагностика
              </summary>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            <button type="button" className="dp-btn" disabled={busy} onClick={() => void refresh()}>
              Обновить статус (диагностика)
            </button>
            {orchRetryable ? (
              <button
                type="button"
                className="dp-btn"
                disabled={busy || !reportRunId}
                onClick={onStartFullAudit}
                data-testid="arsenkin-admin-force-resume"
              >
                Принудительный resume (админ)
              </button>
            ) : null}
            <button
              type="button"
              className="dp-btn"
              disabled={busy || !reportRunId || executeLocked || terminalBad}
              onClick={onPrepare}
            >
              Подготовить полный сбор
            </button>
            <button
              type="button"
              className="dp-btn"
              disabled={busy || !reportRunId || executeLocked || terminalBad}
              onClick={onPlan}
            >
              Сформировать план — без списания
            </button>
            <button
              type="button"
              className="dp-btn"
              disabled={!plan?.digest || busy || executeLocked || terminalBad}
              onClick={() => {
                setConfirmedPaid(false);
                setConfirmOpen(true);
              }}
              data-testid="arsenkin-execute-open"
            >
              Запустить полный сбор Arsenkin (legacy)
            </button>
            {status?.canRefreshReadiness ? (
              <button
                type="button"
                className="dp-btn"
                disabled={busy || status?.status === "READINESS_RUNNING"}
                onClick={onRefreshReadiness}
                data-testid="arsenkin-refresh-db-readiness"
              >
                Повторить проверку БД
              </button>
            ) : null}
            {transferComplete ? (
              <button type="button" className="dp-btn" disabled>
                Результаты переданы в отчёт
              </button>
            ) : (
              <button
                type="button"
                className="dp-btn"
                disabled={busy || !reportRunId || !canTransferUi}
                onClick={onSync}
              >
                Передать результаты в ORION
              </button>
            )}
            <button
              type="button"
              className="dp-btn"
              disabled={busy || !transferComplete}
              onClick={onRebuildReport}
            >
              Пересобрать контент + PDF
            </button>
            <button
              type="button"
              className="dp-btn"
              disabled={busy || !transferComplete}
              onClick={onDownloadDiagnostics}
            >
              Скачать диагностический пакет
            </button>
              </div>
            </details>
          </div>
        ) : (
          <span className="dp-muted">Нужен risk.review для запуска Arsenkin</span>
        )}

        {transferComplete && status?.effectiveReportRunId ? (
          <Notice>
            Effective reportRunId: <code>{status.effectiveReportRunId}</code>
            {status.transferredAt ? ` · ${status.transferredAt}` : ""}. Отчёт будет собран из данных
            Arsenkin.
          </Notice>
        ) : null}

        {!reportRunId ? (
          <span className="dp-muted">Нужен Prepare / reportRunId из очереди ручной проверки.</span>
        ) : null}
      </div>

      {confirmOpen && plan ? (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="arsenkin-execute-confirm-modal"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 80,
            padding: 16,
          }}
        >
          <div className="dp-card" style={{ maxWidth: 520, width: "100%" }}>
            <div className="dp-stack" style={{ gap: 10 }}>
              <strong>Подтверждение платного запуска Arsenkin</strong>
              <div className="dp-kv">
                <div>
                  <span className="dp-muted">stage</span>
                  <div>{stage}</div>
                </div>
                <div>
                  <span className="dp-muted">tools</span>
                  <div>{(status?.tools ?? []).join(", ")}</div>
                </div>
                <div>
                  <span className="dp-muted">CREATE / REUSE</span>
                  <div>
                    {(plan.requests ?? []).map((r) => r.action).join(", ") || "—"}
                  </div>
                </div>
                <div>
                  <span className="dp-muted">plannedNewTasks / estimatedLimits</span>
                  <div>
                    {plan.plannedNewTasks} / {plan.estimatedLimitsTotal}
                  </div>
                </div>
                <div>
                  <span className="dp-muted">максимальный budget</span>
                  <div>
                    {plan.maxNewTasks} / {plan.maxEstimatedLimits}
                  </div>
                </div>
                <div>
                  <span className="dp-muted">digest</span>
                  <div>
                    <code>{shortDigest(plan.digest)}</code>
                  </div>
                </div>
              </div>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={confirmedPaid}
                  onChange={(e) => setConfirmedPaid(e.target.checked)}
                  data-testid="arsenkin-confirm-checkbox"
                />
                <span>Подтверждаю запуск платных API Arsenkin в указанном лимите</span>
              </label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="dp-btn dp-btn-primary"
                  disabled={!canExecuteUi}
                  data-testid="arsenkin-execute-confirm"
                  onClick={onExecuteConfirmed}
                >
                  Запустить
                </button>
                <button
                  type="button"
                  className="dp-btn"
                  onClick={() => {
                    setConfirmOpen(false);
                    setConfirmedPaid(false);
                  }}
                >
                  Отмена
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
    </div>
  );
}
