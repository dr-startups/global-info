"use client";

/**
 * R10.8a — Polished manual review admin UI (Russian-first).
 * Artifact-backed; does not invoke PDF/PPTX renderer.
 * No bulk high-impact approval.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  DigitalProfileApiError,
  getCase,
  getOrionManualReviewItem,
  getOrionManualReviewQueue,
  listOrionAdminReviewDecisions,
  regenerateOrionClientContentAfterReview,
  generateOrionClassicAuditReport,
  getOrionClassicAuditReportStatus,
  captureLiveSerp,
  listSerpCaptures,
  prepareOrionGoldenArtifacts,
  getOrionGoldenPrepareStatus,
  type OrionClassicAuditReportSummary,
  type OrionGoldenPrepareSummary,
  type SerpCaptureDto,
  submitOrionAdminReviewDecision,
  type AdminReviewStatus,
  type AdminReviewDecisionSetDto,
  type CaseDetail,
  type ManualReviewItemDetailDto,
  type ManualReviewQueueDto,
  type ManualReviewQueueItemDto,
  type RegenerateClientContentResult,
  type SubmitAdminReviewDecisionInput,
} from "./api";
import { Badge, Card, EmptyState, ErrorBox, Loading, Notice, SuccessBox, WarningBox } from "./components";
import {
  classifyQueueItemGroup,
  decisionWarningRu,
  GROUP_ORDER,
  isHighImpactItem,
  isSafeLowImpactForBulkAppendix,
  isWrongSubjectCandidate,
  labelBinding,
  labelGroup,
  labelRecommendedAction,
  labelReliability,
  labelRisk,
  labelStatus,
  QUICK_FILTER_LABELS,
  statusTone,
  type ManualReviewUiGroupReason,
  type QuickFilterId,
} from "./manual-review-ui-helpers";
import { useDpAuth } from "./auth-provider";

const STATUSES: AdminReviewStatus[] = [
  "PENDING",
  "APPROVED",
  "APPROVED_WITH_CAVEAT",
  "APPENDIX_ONLY",
  "EXCLUDED",
  "NEEDS_MORE_SOURCES",
  "WRONG_SUBJECT",
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="dp-btn"
      style={{ padding: "2px 8px", fontSize: 12 }}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          // ignore
        }
      }}
    >
      {copied ? "Скопировано" : "Копировать"}
    </button>
  );
}

export function ManualReviewAdminView({ caseId }: { caseId: string }) {
  const { can } = useDpAuth();
  const canView = can("evidence.viewRaw");
  const canDecide = can("risk.review");

  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [queue, setQueue] = useState<ManualReviewQueueDto | null>(null);
  const [decisions, setDecisions] = useState<AdminReviewDecisionSetDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ManualReviewItemDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [regenResult, setRegenResult] = useState<RegenerateClientContentResult | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);
  const [classicAudit, setClassicAudit] = useState<OrionClassicAuditReportSummary | null>(null);
  const [classicAuditBusy, setClassicAuditBusy] = useState(false);
  const [prepareStatus, setPrepareStatus] = useState<OrionGoldenPrepareSummary | null>(null);
  const [prepareBusy, setPrepareBusy] = useState(false);
  const [lastRegenAt, setLastRegenAt] = useState<string | null>(null);
  const [serpCaptures, setSerpCaptures] = useState<SerpCaptureDto[]>([]);
  const [serpCaptureBusy, setSerpCaptureBusy] = useState(false);
  const [activeLiveCapture, setActiveLiveCapture] = useState<string | null>(null);
  const [serpListError, setSerpListError] = useState<string | null>(null);

  // Filters
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterGroup, setFilterGroup] = useState<string>("");
  const [filterRisk, setFilterRisk] = useState<string>("");
  const [filterBinding, setFilterBinding] = useState<string>("");
  const [filterDomain, setFilterDomain] = useState<string>("");
  const [filterReliability, setFilterReliability] = useState<string>("");
  const [filterText, setFilterText] = useState<string>("");
  const [quickFilter, setQuickFilter] = useState<QuickFilterId | "">("");
  const [viewMode, setViewMode] = useState<"table" | "groups">("groups");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  // Selection for safe bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Decision form
  const [status, setStatus] = useState<AdminReviewStatus>("PENDING");
  const [reviewerNote, setReviewerNote] = useState("");
  const [approvedClientSummary, setApprovedClientSummary] = useState("");
  const [caveatText, setCaveatText] = useState("");
  const [requestedSources, setRequestedSources] = useState("");
  const [highImpactAck, setHighImpactAck] = useState(false);
  const [overwriteAck, setOverwriteAck] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [showOverwriteModal, setShowOverwriteModal] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, q, d, classicStatus, prepStatus] = await Promise.all([
        getCase(caseId),
        getOrionManualReviewQueue(caseId),
        listOrionAdminReviewDecisions(caseId).catch(() => null),
        getOrionClassicAuditReportStatus(caseId).catch(() => null),
        getOrionGoldenPrepareStatus(caseId).catch(() => null),
      ]);
      setCaseDetail(c);
      setQueue(q);
      if (d) setDecisions(d);
      if (classicStatus) setClassicAudit(classicStatus);
      if (prepStatus) setPrepareStatus(prepStatus);
    } catch (err) {
      const msg =
        err instanceof DigitalProfileApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Не удалось загрузить очередь";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    if (canView) void loadQueue();
  }, [canView, loadQueue]);

  const reportRunId = queue?.reportRunId ?? null;
  const subjectQuery = caseDetail?.subject?.fullName?.trim() ?? "";

  const loadSerpCaptures = useCallback(async () => {
    if (!reportRunId) {
      setSerpCaptures([]);
      setSerpListError(null);
      return;
    }
    try {
      const res = await listSerpCaptures(caseId, reportRunId);
      setSerpCaptures(res.captures);
      setSerpListError(null);
    } catch (err) {
      setSerpCaptures([]);
      const msg =
        err instanceof DigitalProfileApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Не удалось загрузить LIVE captures";
      setSerpListError(msg);
    }
  }, [caseId, reportRunId]);

  useEffect(() => {
    if (reportRunId) void loadSerpCaptures();
  }, [reportRunId, loadSerpCaptures]);

  const runLiveSerpCapture = async (input: {
    engine: "GOOGLE" | "YANDEX";
    region: "RU" | "UAE";
    label: string;
  }) => {
    if (!canDecide || !reportRunId || !subjectQuery) return;
    const key = `${input.region}:${input.engine}`;
    setSerpCaptureBusy(true);
    setActiveLiveCapture(key);
    setBanner(null);
    try {
      const res = await captureLiveSerp(caseId, reportRunId, {
        query: subjectQuery,
        engine: input.engine,
        region: input.region,
      });
      await loadSerpCaptures();
      const c = res.capture;
      setBanner({
        kind: c.captureStatus === "READY" ? "ok" : "error",
        text:
          c.captureStatus === "READY"
            ? `LIVE SERP (${input.label}): READY${c.geoStatus === "UNVERIFIED" ? " · GEO не подтверждено" : ""}`
            : `LIVE SERP (${input.label}): ${c.captureStatus}${c.errorJson?.message ? ` — ${String(c.errorJson.message)}` : ""}`,
      });
    } catch (err) {
      const msg =
        err instanceof DigitalProfileApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Ошибка LIVE SERP capture";
      setBanner({ kind: "error", text: msg });
    } finally {
      setSerpCaptureBusy(false);
      setActiveLiveCapture(null);
    }
  };

  const openDetail = useCallback(
    async (evidenceId: string, opts?: { force?: boolean }) => {
      if (!opts?.force && formDirty) {
        const ok = window.confirm("Есть несохранённые изменения. Открыть другой материал?");
        if (!ok) return;
      }
      setSelectedId(evidenceId);
      setDetailLoading(true);
      setFormError(null);
      setFieldErrors({});
      setBanner(null);
      setFormDirty(false);
      try {
        const d = await getOrionManualReviewItem(caseId, evidenceId);
        setDetail(d);
        const st = (d.adminDecision?.status as AdminReviewStatus) || "PENDING";
        setStatus(st === "PENDING" ? "APPROVED_WITH_CAVEAT" : st);
        setReviewerNote(d.adminDecision?.reviewerNote ?? "");
        setApprovedClientSummary(d.adminDecision?.approvedClientSummary ?? "");
        setCaveatText(d.adminDecision?.caveatText ?? "");
        setRequestedSources((d.adminDecision?.requestedSources ?? []).join("\n"));
        setHighImpactAck(false);
        setOverwriteAck(false);
        setShowOverwriteModal(false);
      } catch (err) {
        setDetail(null);
        setFormError(err instanceof Error ? err.message : "Не удалось загрузить карточку");
      } finally {
        setDetailLoading(false);
      }
    },
    [caseId, formDirty]
  );

  const filteredItems = useMemo(() => {
    if (!queue) return [];
    return queue.items.filter((item) => {
      const group = classifyQueueItemGroup(item);
      const statusVal = String(item.adminReviewStatus);
      if (filterStatus && statusVal !== filterStatus) return false;
      if (filterGroup && group !== filterGroup) return false;
      if (filterRisk && item.proposedClassification.riskSignal !== filterRisk) return false;
      if (filterBinding && item.proposedClassification.subjectBinding !== filterBinding) return false;
      if (filterDomain && !(item.sourceDomain ?? "").toLowerCase().includes(filterDomain.toLowerCase())) {
        return false;
      }
      if (
        filterReliability &&
        !(item.sourceReliability ?? "").toLowerCase().includes(filterReliability.toLowerCase())
      ) {
        return false;
      }
      if (filterText) {
        const q = filterText.toLowerCase();
        const hay = `${item.title} ${item.snippet} ${item.evidenceId}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (quickFilter === "pending_only" && statusVal !== "PENDING") return false;
      if (quickFilter === "decided_only" && statusVal === "PENDING") return false;
      if (quickFilter === "high_impact_only" && !isHighImpactItem(item)) return false;
      if (quickFilter === "compliance_only" && group !== "compliance_potential_match") return false;
      if (quickFilter === "court_only" && group !== "court_legal_ambiguity") return false;
      if (quickFilter === "homonym_only" && group !== "homonym_weak_binding") return false;
      if (quickFilter === "wrong_subject_candidates" && !isWrongSubjectCandidate(item)) return false;
      return true;
    });
  }, [
    queue,
    filterStatus,
    filterGroup,
    filterRisk,
    filterBinding,
    filterDomain,
    filterReliability,
    filterText,
    quickFilter,
  ]);

  const grouped = useMemo(() => {
    const map = new Map<ManualReviewUiGroupReason, ManualReviewQueueItemDto[]>();
    for (const reason of GROUP_ORDER) map.set(reason, []);
    for (const item of filteredItems) {
      const g = classifyQueueItemGroup(item);
      const list = map.get(g) ?? [];
      list.push(item);
      map.set(g, list);
    }
    return map;
  }, [filteredItems]);

  const counts = queue?.statusCounts ?? {
    PENDING: queue?.pendingCount ?? 0,
    APPROVED: 0,
    APPROVED_WITH_CAVEAT: 0,
    APPENDIX_ONLY: 0,
    EXCLUDED: 0,
    NEEDS_MORE_SOURCES: 0,
    WRONG_SUBJECT: 0,
  };

  const decisionCounts = useMemo(() => {
    const out: Record<string, number> = {
      PENDING: 0,
      APPROVED: 0,
      APPROVED_WITH_CAVEAT: 0,
      APPENDIX_ONLY: 0,
      EXCLUDED: 0,
      NEEDS_MORE_SOURCES: 0,
      WRONG_SUBJECT: 0,
    };
    for (const d of decisions?.decisions ?? []) {
      out[d.status] = (out[d.status] ?? 0) + 1;
    }
    return out;
  }, [decisions]);

  const selectedIndex = useMemo(() => {
    if (!selectedId) return -1;
    return filteredItems.findIndex((i) => i.evidenceId === selectedId);
  }, [filteredItems, selectedId]);

  const goNext = useCallback(() => {
    if (selectedIndex < 0 || selectedIndex >= filteredItems.length - 1) return;
    void openDetail(filteredItems[selectedIndex + 1]!.evidenceId);
  }, [filteredItems, openDetail, selectedIndex]);

  const goPrev = useCallback(() => {
    if (selectedIndex <= 0) return;
    void openDetail(filteredItems[selectedIndex - 1]!.evidenceId);
  }, [filteredItems, openDetail, selectedIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        goNext();
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        goPrev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNext, goPrev]);

  const validateForm = (): boolean => {
    const errs: Record<string, string> = {};
    if (status === "APPROVED_WITH_CAVEAT" && !caveatText.trim()) {
      errs.caveatText = "Для «Одобрено с оговоркой» обязателен текст оговорки.";
    }
    if (status === "WRONG_SUBJECT" && !reviewerNote.trim()) {
      errs.reviewerNote = "Для «Другой субъект» обязательна заметка аналитика.";
    }
    if (status === "EXCLUDED" && !reviewerNote.trim()) {
      errs.reviewerNote = "Для «Исключено» обязательна заметка аналитика.";
    }
    if (status === "NEEDS_MORE_SOURCES") {
      const hasSources = requestedSources
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean).length;
      if (!hasSources && !reviewerNote.trim()) {
        errs.requestedSources = "Укажите источники или заметку аналитика.";
        errs.reviewerNote = "Укажите источники или заметку аналитика.";
      }
    }
    if (detail && status === "APPROVED" && isHighImpactItem(detail) && !highImpactAck) {
      errs.highImpactAck = "Подтвердите осторожное одобрение high-impact материала.";
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const doSubmit = async (opts?: { overwriteConfirmed?: boolean }) => {
    if (!selectedId || !detail || !canDecide) return;
    setFormError(null);
    if (!validateForm()) {
      setFormError("Исправьте ошибки формы.");
      return;
    }
    const existing = (detail.adminDecision?.status as AdminReviewStatus) || "PENDING";
    const overwriteConfirmed =
      opts?.overwriteConfirmed || overwriteAck || existing === "PENDING" || status === existing;
    if (existing !== "PENDING" && status !== existing && !overwriteConfirmed) {
      setShowOverwriteModal(true);
      return;
    }
    setSubmitBusy(true);
    try {
      const input: SubmitAdminReviewDecisionInput = {
        status,
        reviewerNote: reviewerNote.trim() || undefined,
        approvedClientSummary: approvedClientSummary.trim() || undefined,
        caveatText: caveatText.trim() || undefined,
        requestedSources: requestedSources
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        highImpactAcknowledged: highImpactAck,
        overwriteConfirmed,
      };
      await submitOrionAdminReviewDecision(caseId, selectedId, input);
      setBanner({ kind: "ok", text: `Решение «${labelStatus(status)}» сохранено.` });
      setFormDirty(false);
      setShowOverwriteModal(false);
      setOverwriteAck(false);
      await loadQueue();
      await openDetail(selectedId, { force: true });
    } catch (err) {
      const msg =
        err instanceof DigitalProfileApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Ошибка сохранения";
      setFormError(msg);
    } finally {
      setSubmitBusy(false);
    }
  };

  const regenerate = async () => {
    if (!canDecide) return;
    setRegenBusy(true);
    setBanner(null);
    try {
      const result = await regenerateOrionClientContentAfterReview(caseId);
      setRegenResult(result);
      setLastRegenAt(result.generatedAt ?? new Date().toISOString());
      setBanner({
        kind: "ok",
        text: `Клиентский анализ пересобран. Renderer не вызывался. До: ${result.preReviewApprovedCount}, после: ${result.postReviewApprovedCount}.`,
      });
      await loadQueue();
    } catch (err) {
      const msg =
        err instanceof DigitalProfileApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Ошибка пересборки";
      setBanner({ kind: "error", text: msg });
    } finally {
      setRegenBusy(false);
    }
  };

  const generateClassicAudit = async (regenerateContent: boolean) => {
    if (!canDecide) return;
    setClassicAuditBusy(true);
    setBanner(null);
    try {
      let result = await generateOrionClassicAuditReport(caseId, { regenerateContent });
      setClassicAudit(result);
      setBanner({
        kind: "ok",
        text: "Генерация ORION Audit запущена в фоне. Обычно 3–10 минут — статус обновится ниже.",
      });

      for (let i = 0; i < 120; i += 1) {
        if (result.status === "completed" || result.status === "failed") break;
        await new Promise((r) => setTimeout(r, 5000));
        result = await getOrionClassicAuditReportStatus(caseId);
        setClassicAudit(result);
      }

      if (result.status === "completed") {
        const hasPdf = Boolean(result.artifacts.clientPdf.available);
        setBanner({
          kind: result.verdict === "PASS" || hasPdf ? "ok" : "error",
          text:
            result.verdict === "PASS"
              ? `ORION Audit готов: ${result.pageCount} стр.`
              : hasPdf
                ? `Отчёт собран (${result.pageCount} стр.), QA: ${result.verdict}. PDF доступен для скачивания.`
                : `Генерация завершилась: ${result.verdict}. ${result.warnings.slice(0, 2).join("; ")}`,
        });
      } else if (result.status === "running") {
        setBanner({
          kind: "error",
          text: "Генерация ещё идёт. Обновите страницу через минуту.",
        });
      } else {
        setBanner({
          kind: "error",
          text:
            result.warnings[0] ||
            `Генерация не удалась (${result.verdict ?? "FAIL"}). Проверьте HTTP Logs.`,
        });
      }
    } catch (err) {
      const msg =
        err instanceof DigitalProfileApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Ошибка генерации ORION Audit";
      setBanner({ kind: "error", text: msg });
    } finally {
      setClassicAuditBusy(false);
    }
  };

  const prepareGoldenArtifacts = async () => {
    if (!canDecide) return;
    setPrepareBusy(true);
    setBanner(null);
    try {
      let result = await prepareOrionGoldenArtifacts(caseId);
      setPrepareStatus(result);
      setBanner({
        kind: "ok",
        text: "Подготовка запущена в фоне. Обычно 3–10 минут — не закрывайте вкладку.",
      });

      for (let i = 0; i < 90; i += 1) {
        if (result.status === "completed" || result.status === "failed") break;
        await new Promise((r) => setTimeout(r, 5000));
        result = await getOrionGoldenPrepareStatus(caseId);
        setPrepareStatus(result);
      }

      if (result.ok && result.queueReady) {
        setBanner({
          kind: "ok",
          text: `Артефакты ORION Golden готовы. В очереди: ${result.pendingCount}. Обновляем страницу…`,
        });
        await loadQueue();
      } else if (result.status === "running") {
        setBanner({
          kind: "error",
          text: "Подготовка ещё идёт. Нажмите «Повторить» через минуту или обновите статус.",
        });
      } else {
        setBanner({
          kind: "error",
          text:
            result.warnings[0] ||
            `Подготовка не завершена (verdict=${result.verdict ?? "—"}). Проверьте AI/БД и HTTP Logs.`,
        });
      }
    } catch (err) {
      const msg =
        err instanceof DigitalProfileApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Ошибка подготовки артефактов";
      setBanner({ kind: "error", text: msg });
    } finally {
      setPrepareBusy(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulkAppendixSafe = async () => {
    if (!canDecide || selectedIds.size === 0) return;
    const items = (queue?.items ?? []).filter((i) => selectedIds.has(i.evidenceId));
    const unsafe = items.filter((i) => !isSafeLowImpactForBulkAppendix(i));
    if (unsafe.length) {
      setBanner({
        kind: "error",
        text: `Массовое «Только приложение» запрещено для high-impact: ${unsafe.length} из выбранных.`,
      });
      return;
    }
    const ok = window.confirm(
      `Пометить ${items.length} низкорисковых материалов как «Только приложение»? High-impact не затрагиваются.`
    );
    if (!ok) return;
    setSubmitBusy(true);
    try {
      for (const item of items) {
        await submitOrionAdminReviewDecision(caseId, item.evidenceId, {
          status: "APPENDIX_ONLY",
          reviewerNote: "Массово: низкорисковый материал → приложение",
          overwriteConfirmed: true,
        });
      }
      setBanner({ kind: "ok", text: `Обновлено: ${items.length} → Только приложение.` });
      setSelectedIds(new Set());
      await loadQueue();
    } catch (err) {
      setBanner({ kind: "error", text: err instanceof Error ? err.message : "Ошибка массового действия" });
    } finally {
      setSubmitBusy(false);
    }
  };

  const bulkWrongSubjectSafe = async () => {
    if (!canDecide || selectedIds.size === 0) return;
    const items = (queue?.items ?? []).filter((i) => selectedIds.has(i.evidenceId));
    const candidates = items.filter((i) => isWrongSubjectCandidate(i) && !isHighImpactItem(i));
    const skipped = items.length - candidates.length;
    if (!candidates.length) {
      setBanner({
        kind: "error",
        text: "Нет безопасных кандидатов «Другой субъект» среди выбранных (high-impact / без признаков омонимии пропущены).",
      });
      return;
    }
    const ok = window.confirm(
      `Исключить ${candidates.length} кандидатов как «Другой субъект»?` +
        (skipped ? ` Пропущено: ${skipped}.` : "") +
        ` High-impact и compliance не затрагиваются.`
    );
    if (!ok) return;
    setSubmitBusy(true);
    try {
      for (const item of candidates) {
        await submitOrionAdminReviewDecision(caseId, item.evidenceId, {
          status: "WRONG_SUBJECT",
          reviewerNote: "Массово: кандидат другого субъекта (омонимия/отчество)",
          overwriteConfirmed: true,
        });
      }
      setBanner({ kind: "ok", text: `Исключено как другой субъект: ${candidates.length}.` });
      setSelectedIds(new Set());
      await loadQueue();
    } catch (err) {
      setBanner({ kind: "error", text: err instanceof Error ? err.message : "Ошибка массового действия" });
    } finally {
      setSubmitBusy(false);
    }
  };

  if (!canView) {
    return (
      <Card>
        <ErrorBox>Недостаточно прав (нужен evidence.viewRaw).</ErrorBox>
      </Card>
    );
  }

  if (loading) return <Loading label="Загрузка очереди ручной проверки…" />;
  if (error) {
    return (
      <Card>
        <ErrorBox>{error}</ErrorBox>
        <p className="dp-muted" style={{ marginTop: 8 }}>
          Для этого кейса ещё нет артефактов ORION Golden (manual-review-queue.json). Нажмите кнопку ниже —
          система соберёт evidence, judgments и очередь review (без PDF, может занять несколько минут).
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          {canDecide ? (
            <button
              type="button"
              className="dp-btn dp-btn-primary"
              disabled={prepareBusy}
              onClick={() => void prepareGoldenArtifacts()}
            >
              {prepareBusy ? "Подготовка…" : "Подготовить ORION Golden / очередь review"}
            </button>
          ) : (
            <span className="dp-muted">Нужен risk.review для подготовки артефактов</span>
          )}
          <button type="button" className="dp-btn" disabled={prepareBusy} onClick={() => void loadQueue()}>
            Повторить
          </button>
        </div>
        {prepareStatus ? (
          <p className="dp-muted" style={{ marginTop: 8 }}>
            Статус подготовки: {prepareStatus.status}
            {prepareStatus.verdict ? ` · ${prepareStatus.verdict}` : ""}
            {prepareStatus.queueReady ? ` · очередь готова (${prepareStatus.pendingCount})` : ""}
          </p>
        ) : null}
        {banner ? (
          <div style={{ marginTop: 8 }}>
            {banner.kind === "ok" ? <SuccessBox>{banner.text}</SuccessBox> : <ErrorBox>{banner.text}</ErrorBox>}
          </div>
        ) : null}
      </Card>
    );
  }

  const subjectName = caseDetail?.subject?.fullName ?? caseDetail?.title ?? "—";
  const gptAutoAnalyst = queue?.gptAutoAnalystEnabled === true;
  const highImpactSelected = detail ? isHighImpactItem(detail) : false;
  const existingStatus = (detail?.adminDecision?.status as AdminReviewStatus) || "PENDING";
  const riskOptions = [
    ...new Set((queue?.items ?? []).map((i) => i.proposedClassification.riskSignal).filter(Boolean)),
  ];
  const bindingOptions = [
    ...new Set((queue?.items ?? []).map((i) => i.proposedClassification.subjectBinding).filter(Boolean)),
  ];
  const reliabilityOptions = [
    ...new Set((queue?.items ?? []).map((i) => i.sourceReliability).filter(Boolean)),
  ] as string[];

  const renderRow = (item: ManualReviewQueueItemDto) => {
    const group = classifyQueueItemGroup(item);
    return (
      <tr
        key={item.evidenceId}
        style={selectedId === item.evidenceId ? { background: "rgba(0,0,0,0.04)" } : undefined}
      >
        <td>
          <input
            type="checkbox"
            checked={selectedIds.has(item.evidenceId)}
            onChange={() => toggleSelect(item.evidenceId)}
            aria-label="Выбрать"
          />
        </td>
        <td style={{ maxWidth: 280 }}>
          <div style={{ fontWeight: 500 }}>{item.title.slice(0, 90)}</div>
          <div className="dp-muted" style={{ fontSize: 12 }}>
            {item.evidenceId}
          </div>
        </td>
        <td>{item.sourceDomain ?? "—"}</td>
        <td>{labelGroup(group)}</td>
        <td>
          <Badge tone={isHighImpactItem(item) ? "danger" : "neutral"}>
            {labelRisk(item.proposedClassification.riskSignal)}
          </Badge>
        </td>
        <td>{labelBinding(item.proposedClassification.subjectBinding)}</td>
        <td>{labelReliability(item.sourceReliability ?? "UNKNOWN")}</td>
        <td>
          <Badge tone={statusTone(String(item.adminReviewStatus))}>
            {labelStatus(String(item.adminReviewStatus))}
          </Badge>
        </td>
        <td style={{ fontSize: 12 }}>{labelRecommendedAction(item.recommendedAdminAction)}</td>
        <td>
          <button type="button" className="dp-btn" onClick={() => void openDetail(item.evidenceId)}>
            Открыть
          </button>
        </td>
      </tr>
    );
  };

  return (
    <div className="dp-stack" style={{ gap: 16 }} data-r108a-polish="true">
      <div className="dp-stack" style={{ gap: 8 }}>
        <Link href={`/admin/digital-profile/${caseId}`} className="dp-muted">
          ← К карточке кейса
        </Link>
        <h1 style={{ margin: 0 }}>Очередь ручной проверки</h1>
        <p className="dp-muted" style={{ margin: 0 }}>
          Субъект: <strong>{subjectName}</strong> · CASE_ID: <code>{caseId}</code>
        </p>
        <WarningBox>
          {gptAutoAnalyst
            ? "Режим GPT auto-analyst: решения по очереди принимает GPT (мусор отбрасывается автоматически). Ручной gate временно отключён."
            : "Материалы в очереди требуют ручной проверки и не являются подтверждёнными негативными выводами. Статус «Требует проверки» не используется как подтверждённый риск."}
        </WarningBox>
      </div>

      {banner ? (
        banner.kind === "ok" ? <SuccessBox>{banner.text}</SuccessBox> : <ErrorBox>{banner.text}</ErrorBox>
      ) : null}

      <div className="dp-grid-cards" data-testid="status-summary">
        <Card>
          <div className="dp-muted">Всего в очереди</div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>{queue?.items.length ?? 0}</div>
        </Card>
        {STATUSES.map((s) => (
          <Card key={s}>
            <div className="dp-muted">{labelStatus(s)}</div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{counts[s] ?? 0}</div>
          </Card>
        ))}
      </div>

      <Card data-testid="prepare-golden-panel">
        <div className="dp-stack" style={{ gap: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <strong>Подготовка артефактов</strong>
            {canDecide ? (
              <button
                type="button"
                className="dp-btn"
                disabled={prepareBusy}
                onClick={() => void prepareGoldenArtifacts()}
              >
                {prepareBusy ? "Подготовка…" : "Пересобрать ORION Golden / очередь review"}
              </button>
            ) : null}
          </div>
          <Notice>
            Собирает inventory, judgments и manual-review-queue для этого кейса (без PDF). Нужно один раз перед
            первой проверкой или после обновления evidence.
          </Notice>
          {prepareStatus ? (
            <div className="dp-muted">
              Статус: {prepareStatus.status}
              {prepareStatus.queueReady ? ` · очередь готова (${prepareStatus.pendingCount})` : ""}
              {prepareStatus.verdict ? ` · ${prepareStatus.verdict}` : ""}
            </div>
          ) : null}
        </div>
      </Card>

      <Card data-testid="regenerate-panel">
        <div className="dp-stack" style={{ gap: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <strong>Клиентский анализ</strong>
            {canDecide ? (
              <button
                type="button"
                className="dp-btn dp-btn-primary"
                disabled={regenBusy}
                onClick={() => void regenerate()}
              >
                {regenBusy ? "Пересборка…" : "Пересобрать клиентский анализ"}
              </button>
            ) : (
              <span className="dp-muted">Нужен risk.review для решений и пересборки</span>
            )}
            <button type="button" className="dp-btn" onClick={() => void loadQueue()}>
              Обновить очередь
            </button>
          </div>
          <Notice>
            {gptAutoAnalyst
              ? "GPT auto-analyst ON: post-review JSON собирается из section GPT + auto-решений при Prepare. PDF — «Сгенерировать ORION Audit» (ручные PENDING не блокируют)."
              : "Пересборка обновляет pre/post-review JSON/MD по текущим решениям аналитика. PDF не создаёт — для PDF нажмите «Сгенерировать ORION Audit» ниже. Пока все пункты PENDING, post-review почти совпадает с pre-review."}
          </Notice>
          <div className="dp-kv">
            <div>
              <span className="dp-muted">Последняя пересборка</span>
              <div>{lastRegenAt ?? regenResult?.generatedAt ?? "ещё не выполнялась"}</div>
            </div>
            <div>
              <span className="dp-muted">Решения (одобрено / с оговоркой / приложение / исключено)</span>
              <div>
                {decisionCounts.APPROVED}/{decisionCounts.APPROVED_WITH_CAVEAT}/
                {decisionCounts.APPENDIX_ONLY}/{decisionCounts.EXCLUDED + decisionCounts.WRONG_SUBJECT}
              </div>
            </div>
            {regenResult ? (
              <>
                <div>
                  <span className="dp-muted">Артефакты</span>
                  <div>
                    <code>{regenResult.artifactRoot ?? "—"}</code>
                  </div>
                </div>
                <div>
                  <span className="dp-muted">rendererInvoked</span>
                  <div>{String(regenResult.rendererInvoked ?? false)}</div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </Card>

      <Card data-testid="live-serp-capture-panel">
        <div className="dp-stack" style={{ gap: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <strong>LIVE SERP capture</strong>
            {reportRunId ? (
              <span className="dp-muted">
                reportRunId: <code>{reportRunId}</code>
              </span>
            ) : (
              <span className="dp-muted">Нужен Prepare / reportRunId</span>
            )}
          </div>
          <Notice>
            Ручной Playwright-захват поисковой выдачи. Не запускается при генерации PDF. Без прокси — DIRECT +
            GEO не подтверждено (допустимо для staging preview).
          </Notice>
          {subjectQuery ? (
            <div className="dp-muted">
              Запрос: <code>{subjectQuery}</code>
            </div>
          ) : null}
          {canDecide && reportRunId && subjectQuery ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="dp-btn"
                disabled={serpCaptureBusy}
                onClick={() => void runLiveSerpCapture({ engine: "YANDEX", region: "RU", label: "RU Yandex" })}
              >
                {activeLiveCapture === "RU:YANDEX" ? "Захват…" : "RU · Yandex"}
              </button>
              <button
                type="button"
                className="dp-btn"
                disabled={serpCaptureBusy}
                onClick={() => void runLiveSerpCapture({ engine: "GOOGLE", region: "RU", label: "RU Google" })}
              >
                {activeLiveCapture === "RU:GOOGLE" ? "Захват…" : "RU · Google"}
              </button>
              <button
                type="button"
                className="dp-btn"
                disabled={serpCaptureBusy}
                onClick={() => void runLiveSerpCapture({ engine: "GOOGLE", region: "UAE", label: "UAE Google" })}
              >
                {activeLiveCapture === "UAE:GOOGLE" ? "Захват…" : "UAE · Google"}
              </button>
            </div>
          ) : (
            <span className="dp-muted">Кнопки доступны после Prepare и при наличии ФИО субъекта.</span>
          )}
          {serpListError ? (
            <ErrorBox>{serpListError}</ErrorBox>
          ) : serpCaptures.length > 0 ? (
            <div className="dp-stack" style={{ gap: 6 }}>
              {serpCaptures.slice(0, 8).map((c) => (
                <div key={c.id} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <Badge tone={c.captureStatus === "READY" ? "ok" : c.captureStatus === "BLOCKED_CAPTCHA" ? "warn" : "neutral"}>
                    {c.captureStatus}
                  </Badge>
                  <span>
                    {c.region} · {c.engine} · {c.query.slice(0, 48)}
                  </span>
                  <span className="dp-muted">
                    {c.geoStatus === "UNVERIFIED" ? "GEO не подтверждено" : c.geoStatus}
                    {c.connectionMode ? ` · ${c.connectionMode}` : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : reportRunId ? (
            <span className="dp-muted">Захватов для этого report run пока нет.</span>
          ) : null}
        </div>
      </Card>

      <Card data-testid="classic-audit-panel">
        <div className="dp-stack" style={{ gap: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <strong>ORION Audit (полный отчёт)</strong>
            {canDecide ? (
              <>
                <button
                  type="button"
                  className="dp-btn dp-btn-primary"
                  disabled={classicAuditBusy}
                  onClick={() => void generateClassicAudit(false)}
                  title={
                    classicAudit?.status === "running"
                      ? "Если зависло на PENDING после деплоя — нажмите ещё раз после обновления сервиса"
                      : undefined
                  }
                >
                  {classicAuditBusy ? "Генерация…" : "Сгенерировать ORION Audit"}
                </button>
                <button
                  type="button"
                  className="dp-btn"
                  disabled={classicAuditBusy}
                  onClick={() => void generateClassicAudit(true)}
                >
                  Пересобрать контент + PDF
                </button>
              </>
            ) : (
              <span className="dp-muted">Нужен risk.review для генерации отчёта</span>
            )}
          </div>
          <Notice>
            {gptAutoAnalyst
              ? "Classic ORION audit: после Prepare с auto-analyst можно сразу генерировать PDF без ручного review."
              : "Полный клиентский аудит по структуре ORION (~60+ стр.): резюме, RU/UAE, подсказки, compliance-базы и коммерческое предложение. Требует post-review контент."}
          </Notice>
          {classicAudit ? (
            <div className="dp-kv">
              <div>
                <span className="dp-muted">Статус</span>
                <div>
                  {classicAudit.status} · {classicAudit.pageCount} стр. · {classicAudit.verdict ?? "—"}
                </div>
              </div>
              {classicAudit.artifacts.clientPdf.available && classicAudit.artifacts.clientPdf.downloadUrl ? (
                <div>
                  <a className="dp-btn" href={classicAudit.artifacts.clientPdf.downloadUrl}>
                    Скачать PDF
                  </a>
                </div>
              ) : null}
              {classicAudit.artifacts.clientPptx.available && classicAudit.artifacts.clientPptx.downloadUrl ? (
                <div>
                  <a className="dp-btn" href={classicAudit.artifacts.clientPptx.downloadUrl}>
                    Скачать PPTX
                  </a>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>

      <Card data-testid="filters-panel">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          {(Object.keys(QUICK_FILTER_LABELS) as QuickFilterId[]).map((id) => (
            <button
              key={id}
              type="button"
              className={`dp-btn ${quickFilter === id ? "dp-btn-primary" : ""}`}
              onClick={() => setQuickFilter((prev) => (prev === id ? "" : id))}
            >
              {QUICK_FILTER_LABELS[id]}
            </button>
          ))}
          <button
            type="button"
            className={`dp-btn ${viewMode === "groups" ? "dp-btn-primary" : ""}`}
            onClick={() => setViewMode("groups")}
          >
            Группы
          </button>
          <button
            type="button"
            className={`dp-btn ${viewMode === "table" ? "dp-btn-primary" : ""}`}
            onClick={() => setViewMode("table")}
          >
            Таблица
          </button>
        </div>

        <div className="dp-form-grid" style={{ marginBottom: 12 }}>
          <label className="dp-field">
            <span>Статус</span>
            <select className="dp-select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">Все</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {labelStatus(s)}
                </option>
              ))}
            </select>
          </label>
          <label className="dp-field">
            <span>Группа / причина</span>
            <select className="dp-select" value={filterGroup} onChange={(e) => setFilterGroup(e.target.value)}>
              <option value="">Все</option>
              {GROUP_ORDER.map((g) => (
                <option key={g} value={g}>
                  {labelGroup(g)}
                </option>
              ))}
            </select>
          </label>
          <label className="dp-field">
            <span>Сигнал риска</span>
            <select className="dp-select" value={filterRisk} onChange={(e) => setFilterRisk(e.target.value)}>
              <option value="">Все</option>
              {riskOptions.map((r) => (
                <option key={r} value={r}>
                  {labelRisk(r)}
                </option>
              ))}
            </select>
          </label>
          <label className="dp-field">
            <span>Привязка к субъекту</span>
            <select className="dp-select" value={filterBinding} onChange={(e) => setFilterBinding(e.target.value)}>
              <option value="">Все</option>
              {bindingOptions.map((b) => (
                <option key={b} value={b}>
                  {labelBinding(b)}
                </option>
              ))}
            </select>
          </label>
          <label className="dp-field">
            <span>Домен источника</span>
            <input
              className="dp-input"
              value={filterDomain}
              onChange={(e) => setFilterDomain(e.target.value)}
              placeholder="domain"
            />
          </label>
          <label className="dp-field">
            <span>Надёжность источника</span>
            <select
              className="dp-select"
              value={filterReliability}
              onChange={(e) => setFilterReliability(e.target.value)}
            >
              <option value="">Все</option>
              {reliabilityOptions.map((r) => (
                <option key={r} value={r}>
                  {labelReliability(r)}
                </option>
              ))}
            </select>
          </label>
          <label className="dp-field">
            <span>Поиск</span>
            <input
              className="dp-input"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="заголовок / сниппет / id"
            />
          </label>
        </div>

        {canDecide && selectedIds.size > 0 ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }} data-testid="safe-bulk-actions">
            <Notice>
              Выбрано: {selectedIds.size}. Массовое одобрение high-impact / compliance запрещено.
            </Notice>
            <button type="button" className="dp-btn" disabled={submitBusy} onClick={() => void bulkAppendixSafe()}>
              Массово → Только приложение (низкий риск)
            </button>
            <button type="button" className="dp-btn" disabled={submitBusy} onClick={() => void bulkWrongSubjectSafe()}>
              Массово → Другой субъект (кандидаты)
            </button>
            <button type="button" className="dp-btn" onClick={() => setSelectedIds(new Set())}>
              Снять выбор
            </button>
          </div>
        ) : null}

        {filteredItems.length === 0 ? (
          <EmptyState title="Нет элементов" hint="Очередь пуста или фильтры слишком узкие." />
        ) : viewMode === "table" ? (
          <div style={{ overflowX: "auto" }} data-testid="queue-table">
            <table className="dp-table">
              <thead>
                <tr>
                  <th />
                  <th>Заголовок</th>
                  <th>Домен</th>
                  <th>Группа</th>
                  <th>Риск</th>
                  <th>Привязка</th>
                  <th>Надёжность</th>
                  <th>Статус</th>
                  <th>Рекомендация</th>
                  <th />
                </tr>
              </thead>
              <tbody>{filteredItems.map(renderRow)}</tbody>
            </table>
          </div>
        ) : (
          <div className="dp-stack" style={{ gap: 12 }} data-testid="group-view">
            {GROUP_ORDER.map((reason) => {
              const items = grouped.get(reason) ?? [];
              if (!items.length) return null;
              const pending = items.filter((i) => String(i.adminReviewStatus) === "PENDING").length;
              const decided = items.length - pending;
              const high = items.filter((i) => isHighImpactItem(i)).length;
              const collapsed = collapsedGroups[reason] === true;
              return (
                <div key={reason} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12 }}>
                  <button
                    type="button"
                    className="dp-btn"
                    style={{ width: "100%", textAlign: "left", marginBottom: 8 }}
                    onClick={() =>
                      setCollapsedGroups((prev) => ({ ...prev, [reason]: !collapsed }))
                    }
                  >
                    <strong>{labelGroup(reason)}</strong>
                    {" · "}
                    {items.length} мат. · на проверке {pending} · решено {decided}
                    {high ? ` · high-impact ${high}` : ""}
                    {collapsed ? " ▸" : " ▾"}
                  </button>
                  {!collapsed ? (
                    <div style={{ overflowX: "auto" }}>
                      <table className="dp-table">
                        <thead>
                          <tr>
                            <th />
                            <th>Заголовок</th>
                            <th>Домен</th>
                            <th>Группа</th>
                            <th>Риск</th>
                            <th>Привязка</th>
                            <th>Надёжность</th>
                            <th>Статус</th>
                            <th>Рекомендация</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>{items.map(renderRow)}</tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {selectedId ? (
        <Card data-testid="detail-panel">
          {detailLoading || !detail ? (
            <Loading label="Загрузка карточки…" />
          ) : (
            <div className="dp-stack" style={{ gap: 12 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <h2 style={{ margin: 0, flex: 1 }}>{detail.title}</h2>
                <button type="button" className="dp-btn" disabled={selectedIndex <= 0} onClick={goPrev}>
                  ← Пред.
                </button>
                <button
                  type="button"
                  className="dp-btn"
                  disabled={selectedIndex < 0 || selectedIndex >= filteredItems.length - 1}
                  onClick={goNext}
                >
                  След. →
                </button>
                <span className="dp-muted" style={{ fontSize: 12 }}>
                  {selectedIndex + 1}/{filteredItems.length} · j/k
                </span>
              </div>

              <WarningBox>
                Материал требует ручной проверки и не является подтверждённым негативным выводом.
              </WarningBox>
              {highImpactSelected ? (
                <WarningBox>
                  High-impact категория (compliance / суд / adverse / watchlist). Одобрение требует явного
                  подтверждения осторожности.
                </WarningBox>
              ) : null}

              <div className="dp-kv">
                <div>
                  <span className="dp-muted">evidenceId</span>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <code>{detail.evidenceId}</code>
                    <CopyButton text={detail.evidenceId} />
                  </div>
                </div>
                <div>
                  <span className="dp-muted">URL</span>
                  <div>
                    {detail.url ? (
                      <a href={detail.url} target="_blank" rel="noreferrer">
                        {detail.url}
                      </a>
                    ) : (
                      "—"
                    )}
                  </div>
                </div>
                <div>
                  <span className="dp-muted">Домен / надёжность</span>
                  <div>
                    {detail.sourceDomain ?? "—"} · {labelReliability(detail.sourceReliability ?? "UNKNOWN")}
                  </div>
                </div>
                <div>
                  <span className="dp-muted">Группа</span>
                  <div>{labelGroup(classifyQueueItemGroup(detail))}</div>
                </div>
                <div>
                  <span className="dp-muted">Привязка к субъекту</span>
                  <div>
                    {labelBinding(detail.proposedClassification.subjectBinding)}
                    {detail.subjectBindingScore != null ? ` (score ${detail.subjectBindingScore})` : ""}
                  </div>
                </div>
                <div>
                  <span className="dp-muted">Риск / характер</span>
                  <div>
                    {labelRisk(detail.proposedClassification.riskSignal)} ·{" "}
                    {detail.contentNature ?? detail.proposedClassification.contentNature}
                  </div>
                </div>
                <div>
                  <span className="dp-muted">Рекомендуемое действие</span>
                  <div>{labelRecommendedAction(detail.recommendedAdminAction)}</div>
                </div>
                <div>
                  <span className="dp-muted">Текущий статус</span>
                  <div>
                    <Badge tone={statusTone(String(existingStatus))}>{labelStatus(existingStatus)}</Badge>
                  </div>
                </div>
                <div>
                  <span className="dp-muted">Использование в контенте</span>
                  <div>
                    Pre-review: не как подтверждённый риск при статусе «Требует проверки». Post-review: зависит от
                    сохранённого решения аналитика.
                  </div>
                </div>
              </div>

              <div>
                <strong>Сниппет</strong>
                <p style={{ whiteSpace: "pre-wrap" }}>{detail.snippet}</p>
              </div>
              {detail.subjectBindingExplanation ? (
                <div data-testid="binding-explanation">
                  <strong>Объяснение привязки</strong>
                  <p>{detail.subjectBindingExplanation}</p>
                </div>
              ) : null}
              {detail.subjectBindingPositiveSignals?.length ? (
                <div data-testid="positive-signals">
                  <strong>Положительные сигналы идентичности</strong>
                  <ul>
                    {detail.subjectBindingPositiveSignals.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {detail.subjectBindingNegativeSignals?.length ? (
                <div data-testid="negative-signals">
                  <strong>Отрицательные сигналы идентичности</strong>
                  <ul>
                    {detail.subjectBindingNegativeSignals.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div data-testid="why-flagged">
                <strong>Почему на проверке</strong>
                <p>{detail.whyAgentFlagged}</p>
              </div>
              <div data-testid="missing-context">
                <strong>Недостающий контекст</strong>
                <ul>
                  {detail.missingContext.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
              <div data-testid="risk-interpretation">
                <strong>Интерпретация риска</strong>
                <p>{detail.riskInterpretation}</p>
              </div>
              <div data-testid="neutral-interpretation">
                <strong>Нейтральная интерпретация</strong>
                <p>{detail.neutralInterpretation}</p>
              </div>
              {detail.positiveInterpretation ? (
                <div data-testid="positive-interpretation">
                  <strong>Позитивная интерпретация</strong>
                  <p>{detail.positiveInterpretation}</p>
                </div>
              ) : null}

              {detail.adminDecision?.reviewedAt || detail.adminDecision?.reviewerNote ? (
                <div data-testid="decision-history">
                  <strong>Текущее решение</strong>
                  <p className="dp-muted" style={{ margin: 0 }}>
                    {labelStatus(String(detail.adminDecision.status))}
                    {detail.adminDecision.reviewedAt ? ` · ${detail.adminDecision.reviewedAt}` : ""}
                    {detail.adminDecision.reviewedBy ? ` · ${detail.adminDecision.reviewedBy}` : ""}
                  </p>
                  {detail.adminDecision.reviewerNote ? <p>{detail.adminDecision.reviewerNote}</p> : null}
                  {detail.adminDecision.caveatText ? (
                    <p>
                      <em>Оговорка:</em> {detail.adminDecision.caveatText}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {canDecide && !gptAutoAnalyst ? (
                <div
                  className="dp-stack"
                  style={{ gap: 10, borderTop: "1px solid #ddd", paddingTop: 12 }}
                  data-testid="decision-form"
                >
                  <h3 style={{ margin: 0 }}>Решение аналитика</h3>
                  {formDirty ? <Notice>Есть несохранённые изменения.</Notice> : null}
                  {decisionWarningRu(status) ? <Notice>{decisionWarningRu(status)}</Notice> : null}
                  <div className="dp-form-grid">
                    <label className="dp-field">
                      <span>Статус</span>
                      <select
                        className="dp-select"
                        value={status}
                        onChange={(e) => {
                          setStatus(e.target.value as AdminReviewStatus);
                          setFormDirty(true);
                        }}
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {labelStatus(s)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="dp-field">
                      <span>Клиентская формулировка</span>
                      <textarea
                        className="dp-input"
                        rows={2}
                        value={approvedClientSummary}
                        onChange={(e) => {
                          setApprovedClientSummary(e.target.value);
                          setFormDirty(true);
                        }}
                      />
                    </label>
                    <label className="dp-field">
                      <span>
                        Текст оговорки {status === "APPROVED_WITH_CAVEAT" ? "(обязательно)" : ""}
                      </span>
                      <textarea
                        className="dp-input"
                        rows={2}
                        value={caveatText}
                        onChange={(e) => {
                          setCaveatText(e.target.value);
                          setFormDirty(true);
                        }}
                      />
                      {fieldErrors.caveatText ? (
                        <span style={{ color: "#b91c1c", fontSize: 12 }}>{fieldErrors.caveatText}</span>
                      ) : null}
                    </label>
                    <label className="dp-field">
                      <span>
                        Заметка аналитика{" "}
                        {status === "WRONG_SUBJECT" || status === "EXCLUDED" || status === "NEEDS_MORE_SOURCES"
                          ? "(обязательно)"
                          : ""}
                      </span>
                      <textarea
                        className="dp-input"
                        rows={2}
                        value={reviewerNote}
                        onChange={(e) => {
                          setReviewerNote(e.target.value);
                          setFormDirty(true);
                        }}
                      />
                      {fieldErrors.reviewerNote ? (
                        <span style={{ color: "#b91c1c", fontSize: 12 }}>{fieldErrors.reviewerNote}</span>
                      ) : null}
                    </label>
                    <label className="dp-field">
                      <span>Запрошенные источники (по строке)</span>
                      <textarea
                        className="dp-input"
                        rows={2}
                        value={requestedSources}
                        onChange={(e) => {
                          setRequestedSources(e.target.value);
                          setFormDirty(true);
                        }}
                      />
                      {fieldErrors.requestedSources ? (
                        <span style={{ color: "#b91c1c", fontSize: 12 }}>{fieldErrors.requestedSources}</span>
                      ) : null}
                    </label>
                  </div>

                  {highImpactSelected && status === "APPROVED" ? (
                    <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <input
                        type="checkbox"
                        checked={highImpactAck}
                        onChange={(e) => {
                          setHighImpactAck(e.target.checked);
                          setFormDirty(true);
                        }}
                      />
                      <span>
                        Подтверждаю осторожное «Одобрено» для high-impact материала (compliance / суд / adverse /
                        watchlist). Это не автоматическое одобрение системой.
                      </span>
                    </label>
                  ) : null}
                  {fieldErrors.highImpactAck ? (
                    <span style={{ color: "#b91c1c", fontSize: 12 }}>{fieldErrors.highImpactAck}</span>
                  ) : null}

                  {existingStatus !== "PENDING" && status !== existingStatus ? (
                    <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <input
                        type="checkbox"
                        checked={overwriteAck}
                        onChange={(e) => {
                          setOverwriteAck(e.target.checked);
                          setFormDirty(true);
                        }}
                      />
                      <span>
                        Подтверждаю перезапись решения ({labelStatus(existingStatus)} → {labelStatus(status)}).
                      </span>
                    </label>
                  ) : null}

                  {formError ? <ErrorBox>{formError}</ErrorBox> : null}

                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="dp-btn dp-btn-primary"
                      disabled={submitBusy}
                      onClick={() => void doSubmit()}
                    >
                      {submitBusy ? "Сохранение…" : "Сохранить решение"}
                    </button>
                    <button
                      type="button"
                      className="dp-btn"
                      onClick={() => {
                        if (formDirty && !window.confirm("Закрыть без сохранения?")) return;
                        setSelectedId(null);
                        setFormDirty(false);
                      }}
                    >
                      Закрыть
                    </button>
                  </div>
                </div>
              ) : gptAutoAnalyst && canDecide ? (
                <Notice data-testid="decision-form-disabled">
                  Ручные решения отключены (GPT auto-analyst). Очередь доступна только для просмотра.
                </Notice>
              ) : (
                <Notice>Просмотр без права risk.review — решения недоступны.</Notice>
              )}
            </div>
          )}
        </Card>
      ) : null}

      {showOverwriteModal ? (
        <div
          data-testid="overwrite-modal"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
        >
          <Card>
            <div className="dp-stack" style={{ gap: 10, maxWidth: 420 }}>
              <strong>Подтвердите перезапись решения</strong>
              <p>
                Текущий статус: {labelStatus(existingStatus)}. Новый: {labelStatus(status)}.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="dp-btn dp-btn-primary"
                  onClick={() => {
                    setOverwriteAck(true);
                    setShowOverwriteModal(false);
                    void doSubmit({ overwriteConfirmed: true });
                  }}
                >
                  Перезаписать
                </button>
                <button type="button" className="dp-btn" onClick={() => setShowOverwriteModal(false)}>
                  Отмена
                </button>
              </div>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
