"use client";

/**
 * Arsenkin Tools UI panel — API collector, not Playwright LIVE SERP.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DigitalProfileApiError,
  executeArsenkinRun,
  getArsenkinStatus,
  planArsenkinRun,
  prepareArsenkinRun,
  refreshArsenkinDbReadiness,
  syncArsenkinRun,
  type ArsenkinUiPlanDto,
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
        stopPolling();
        setExecuteLocked(false);
      }
      return s;
    } catch (e) {
      const msg =
        e instanceof DigitalProfileApiError ? e.message : "Не удалось получить статус Arsenkin";
      setError(msg);
      stopPolling();
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
              Сначала FIRST36_STAGE1, после DONE — FIRST36_STAGE2. Две стадии одним кликом не
              запускаются.
            </span>
          )}
        </div>

        <div className="dp-kv">
          <div>
            <span className="dp-muted">исходный ORION reportRunId</span>
            <div>
              <code>{status?.sourceReportRunId ?? reportRunId ?? "—"}</code>
            </div>
          </div>
          <div>
            <span className="dp-muted">Arsenkin reportRunId</span>
            <div>
              <code>{status?.arsenkinReportRunId ?? status?.reportRunId ?? "—"}</code>
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="dp-btn"
              disabled={busy || !reportRunId || executeLocked || terminalBad}
              onClick={onPrepare}
            >
              Подготовить Arsenkin
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
              className="dp-btn dp-btn-primary"
              disabled={!plan?.digest || busy || executeLocked || terminalBad}
              onClick={() => {
                setConfirmedPaid(false);
                setConfirmOpen(true);
              }}
              data-testid="arsenkin-execute-open"
            >
              Запустить Arsenkin
            </button>
            <button type="button" className="dp-btn" disabled={busy} onClick={() => void refresh()}>
              Обновить статус
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
