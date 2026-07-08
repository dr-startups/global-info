"use client";

/**
 * R10.8 — Manual review admin UI for ORION Golden evidence decisions.
 * Artifact-backed; does not invoke PDF/PPTX renderer.
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
  submitOrionAdminReviewDecision,
  type AdminReviewStatus,
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
  MANUAL_REVIEW_GROUP_LABELS,
  type ManualReviewUiGroupReason,
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

const HIGH_IMPACT_RISKS = new Set([
  "COMPLIANCE_RELEVANT",
  "POSSIBLE_ADVERSE",
  "ADVERSE_CONFIRMED",
  "CONTROVERSIAL_DUAL_USE",
]);

function isHighImpact(item: ManualReviewQueueItemDto | ManualReviewItemDetailDto): boolean {
  const group = classifyQueueItemGroup(item);
  if (
    group === "compliance_potential_match" ||
    group === "court_legal_ambiguity" ||
    group === "controversial_dual_use"
  ) {
    return true;
  }
  if (HIGH_IMPACT_RISKS.has(item.proposedClassification.riskSignal)) return true;
  if (item.flags.includes("compliance_db_potential_match") || item.flags.includes("high_impact_manual")) {
    return true;
  }
  return /lexis|world[- ]?check|dow jones|watchlist|санкц|pep|rca|offshore|офшор/i.test(
    `${item.title} ${item.sourceDomain ?? ""}`
  );
}

function statusTone(status: string): "neutral" | "ok" | "warn" | "danger" | "info" {
  if (status === "APPROVED") return "ok";
  if (status === "APPROVED_WITH_CAVEAT") return "info";
  if (status === "APPENDIX_ONLY") return "neutral";
  if (status === "EXCLUDED" || status === "WRONG_SUBJECT") return "danger";
  if (status === "NEEDS_MORE_SOURCES" || status === "PENDING") return "warn";
  return "neutral";
}

function decisionWarning(status: AdminReviewStatus): string | null {
  switch (status) {
    case "APPROVED_WITH_CAVEAT":
      return "APPROVED_WITH_CAVEAT будет включено в клиентский анализ только с оговоркой.";
    case "WRONG_SUBJECT":
      return "WRONG_SUBJECT будет полностью исключён из клиентского анализа.";
    case "EXCLUDED":
      return "EXCLUDED не попадёт в клиентский отчёт.";
    case "PENDING":
      return "PENDING не используется как подтверждённый риск.";
    case "APPENDIX_ONLY":
      return "APPENDIX_ONLY не попадает в основные выводы клиента.";
    case "APPROVED":
      return "APPROVED включает материал в клиентский анализ как одобренный вывод.";
    default:
      return null;
  }
}

export function ManualReviewAdminView({ caseId }: { caseId: string }) {
  const { can } = useDpAuth();
  const canView = can("evidence.viewRaw");
  const canDecide = can("risk.review");

  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [queue, setQueue] = useState<ManualReviewQueueDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ManualReviewItemDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [regenResult, setRegenResult] = useState<RegenerateClientContentResult | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);

  // Filters
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterGroup, setFilterGroup] = useState<string>("");
  const [filterRisk, setFilterRisk] = useState<string>("");
  const [filterBinding, setFilterBinding] = useState<string>("");
  const [filterDomain, setFilterDomain] = useState<string>("");
  const [filterText, setFilterText] = useState<string>("");

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

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, q] = await Promise.all([getCase(caseId), getOrionManualReviewQueue(caseId)]);
      setCaseDetail(c);
      setQueue(q);
      // Warm decisions list (ensures pending set exists)
      try {
        await listOrionAdminReviewDecisions(caseId);
      } catch {
        // non-fatal
      }
    } catch (err) {
      const msg =
        err instanceof DigitalProfileApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Failed to load queue";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    if (canView) void loadQueue();
  }, [canView, loadQueue]);

  const openDetail = useCallback(
    async (evidenceId: string) => {
      setSelectedId(evidenceId);
      setDetailLoading(true);
      setFormError(null);
      setBanner(null);
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
      } catch (err) {
        setDetail(null);
        setFormError(err instanceof Error ? err.message : "Failed to load item");
      } finally {
        setDetailLoading(false);
      }
    },
    [caseId]
  );

  const filteredItems = useMemo(() => {
    if (!queue) return [];
    return queue.items.filter((item) => {
      const group = classifyQueueItemGroup(item);
      if (filterStatus && item.adminReviewStatus !== filterStatus) return false;
      if (filterGroup && group !== filterGroup) return false;
      if (filterRisk && item.proposedClassification.riskSignal !== filterRisk) return false;
      if (filterBinding && item.proposedClassification.subjectBinding !== filterBinding) return false;
      if (filterDomain && !(item.sourceDomain ?? "").toLowerCase().includes(filterDomain.toLowerCase())) {
        return false;
      }
      if (filterText) {
        const q = filterText.toLowerCase();
        const hay = `${item.title} ${item.snippet} ${item.evidenceId}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [queue, filterStatus, filterGroup, filterRisk, filterBinding, filterDomain, filterText]);

  const counts = queue?.statusCounts ?? {
    PENDING: queue?.pendingCount ?? 0,
    APPROVED: 0,
    APPROVED_WITH_CAVEAT: 0,
    APPENDIX_ONLY: 0,
    EXCLUDED: 0,
    NEEDS_MORE_SOURCES: 0,
    WRONG_SUBJECT: 0,
  };

  const submitDecision = async () => {
    if (!selectedId || !detail || !canDecide) return;
    setFormError(null);
    setSubmitBusy(true);
    try {
      const existing = (detail.adminDecision?.status as AdminReviewStatus) || "PENDING";
      const highImpact = isHighImpact(detail);
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
        overwriteConfirmed: overwriteAck,
      };
      if (status === "APPROVED_WITH_CAVEAT" && !input.caveatText) {
        throw new Error("Для APPROVED_WITH_CAVEAT требуется текст оговорки (caveatText).");
      }
      if (status === "WRONG_SUBJECT" && !input.reviewerNote) {
        throw new Error("Для WRONG_SUBJECT требуется reviewerNote.");
      }
      if (
        status === "NEEDS_MORE_SOURCES" &&
        !(input.requestedSources?.length || input.reviewerNote)
      ) {
        throw new Error("Для NEEDS_MORE_SOURCES укажите requestedSources или reviewerNote.");
      }
      if (status === "APPROVED" && highImpact && !highImpactAck) {
        throw new Error("High-impact материал: подтвердите осторожное одобрение.");
      }
      if (existing !== "PENDING" && status !== existing && !overwriteAck) {
        throw new Error("Подтвердите перезапись существующего решения.");
      }

      await submitOrionAdminReviewDecision(caseId, selectedId, input);
      setBanner({ kind: "ok", text: `Решение ${status} сохранено для ${selectedId}.` });
      await loadQueue();
      await openDetail(selectedId);
    } catch (err) {
      const msg =
        err instanceof DigitalProfileApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Submit failed";
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
      setBanner({
        kind: "ok",
        text: `Клиентский анализ пересобран (post-review). Renderer не вызывался. pre=${result.preReviewApprovedCount} post=${result.postReviewApprovedCount}`,
      });
    } catch (err) {
      const msg =
        err instanceof DigitalProfileApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Regenerate failed";
      setBanner({ kind: "error", text: msg });
    } finally {
      setRegenBusy(false);
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
          Убедитесь, что для кейса сгенерированы ORION Golden артефакты (manual-review-queue.json).
        </p>
        <button type="button" className="dp-btn" onClick={() => void loadQueue()}>
          Повторить
        </button>
      </Card>
    );
  }

  const subjectName = caseDetail?.subject?.fullName ?? caseDetail?.title ?? "—";
  const highImpactSelected = detail ? isHighImpact(detail) : false;
  const existingStatus = (detail?.adminDecision?.status as AdminReviewStatus) || "PENDING";

  return (
    <div className="dp-stack" style={{ gap: 16 }}>
      <div className="dp-stack" style={{ gap: 8 }}>
        <Link href={`/admin/digital-profile/${caseId}`} className="dp-muted">
          ← К карточке кейса
        </Link>
        <h1 style={{ margin: 0 }}>ORION Golden — ручная проверка</h1>
        <p className="dp-muted" style={{ margin: 0 }}>
          Субъект: <strong>{subjectName}</strong> · CASE_ID: <code>{caseId}</code>
        </p>
        <WarningBox>Материалы в очереди требуют ручной проверки и не являются подтверждёнными негативными выводами. PENDING не используется как подтверждённый риск.</WarningBox>
      </div>

      {banner ? (
        banner.kind === "ok" ? <SuccessBox>{banner.text}</SuccessBox> : <ErrorBox>{banner.text}</ErrorBox>
      ) : null}

      <div className="dp-grid-cards">
        <Card>
          <div className="dp-muted">Всего в очереди</div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>{queue?.items.length ?? 0}</div>
        </Card>
        {STATUSES.map((s) => (
          <Card key={s}>
            <div className="dp-muted">{s}</div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{counts[s] ?? 0}</div>
          </Card>
        ))}
      </div>

      <Card>
        <div className="dp-stack" style={{ gap: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <strong>Действия</strong>
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
          <Notice>Пересборка обновляет pre/post-review JSON/MD артефакты. PDF/PPTX renderer не вызывается.</Notice>
          {regenResult ? (
            <div className="dp-kv">
              <div>
                <span className="dp-muted">generatedAt</span>
                <div>{regenResult.generatedAt ?? "—"}</div>
              </div>
              <div>
                <span className="dp-muted">artifactRoot</span>
                <div>
                  <code>{regenResult.artifactRoot ?? "—"}</code>
                </div>
              </div>
              <div>
                <span className="dp-muted">rendererInvoked</span>
                <div>{String(regenResult.rendererInvoked ?? false)}</div>
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      <Card>
        <div className="dp-form-grid" style={{ marginBottom: 12 }}>
          <label className="dp-field">
            <span>Status</span>
            <select className="dp-select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">Все</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="dp-field">
            <span>Group / reason</span>
            <select className="dp-select" value={filterGroup} onChange={(e) => setFilterGroup(e.target.value)}>
              <option value="">Все</option>
              {(Object.keys(MANUAL_REVIEW_GROUP_LABELS) as ManualReviewUiGroupReason[]).map((g) => (
                <option key={g} value={g}>
                  {MANUAL_REVIEW_GROUP_LABELS[g]}
                </option>
              ))}
            </select>
          </label>
          <label className="dp-field">
            <span>Risk signal</span>
            <input
              className="dp-input"
              value={filterRisk}
              onChange={(e) => setFilterRisk(e.target.value)}
              placeholder="COMPLIANCE_RELEVANT…"
            />
          </label>
          <label className="dp-field">
            <span>Subject binding</span>
            <input
              className="dp-input"
              value={filterBinding}
              onChange={(e) => setFilterBinding(e.target.value)}
              placeholder="CONFIRMED / WEAK…"
            />
          </label>
          <label className="dp-field">
            <span>Source domain</span>
            <input
              className="dp-input"
              value={filterDomain}
              onChange={(e) => setFilterDomain(e.target.value)}
              placeholder="domain"
            />
          </label>
          <label className="dp-field">
            <span>Search</span>
            <input
              className="dp-input"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="title / snippet / id"
            />
          </label>
        </div>

        {filteredItems.length === 0 ? (
          <EmptyState title="Нет элементов" hint="Очередь пуста или фильтры слишком узкие." />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="dp-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Domain</th>
                  <th>Group</th>
                  <th>Risk</th>
                  <th>Binding</th>
                  <th>Reliability</th>
                  <th>Status</th>
                  <th>Recommended</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => {
                  const group = classifyQueueItemGroup(item);
                  return (
                    <tr key={item.evidenceId} style={selectedId === item.evidenceId ? { background: "rgba(0,0,0,0.04)" } : undefined}>
                      <td style={{ maxWidth: 280 }}>
                        <div style={{ fontWeight: 500 }}>{item.title.slice(0, 90)}</div>
                        <div className="dp-muted" style={{ fontSize: 12 }}>
                          {item.evidenceId}
                        </div>
                      </td>
                      <td>{item.sourceDomain ?? "—"}</td>
                      <td>{MANUAL_REVIEW_GROUP_LABELS[group]}</td>
                      <td>
                        <Badge tone={HIGH_IMPACT_RISKS.has(item.proposedClassification.riskSignal) ? "danger" : "neutral"}>
                          {item.proposedClassification.riskSignal}
                        </Badge>
                      </td>
                      <td>{item.proposedClassification.subjectBinding}</td>
                      <td>{item.sourceReliability ?? "—"}</td>
                      <td>
                        <Badge tone={statusTone(String(item.adminReviewStatus))}>
                          {item.adminReviewStatus}
                        </Badge>
                      </td>
                      <td style={{ fontSize: 12 }}>{item.recommendedAdminAction}</td>
                      <td>
                        <button type="button" className="dp-btn" onClick={() => void openDetail(item.evidenceId)}>
                          Открыть
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selectedId ? (
        <Card>
          {detailLoading || !detail ? (
            <Loading label="Загрузка карточки…" />
          ) : (
            <div className="dp-stack" style={{ gap: 12 }}>
              <h2 style={{ margin: 0 }}>{detail.title}</h2>
              <WarningBox>Материал требует ручной проверки и не является подтверждённым негативным выводом.</WarningBox>
              {highImpactSelected ? (
                <WarningBox>High-impact категория (compliance / court / adverse / watchlist). Одобрение требует явного подтверждения осторожности.</WarningBox>
              ) : null}

              <div className="dp-kv">
                <div>
                  <span className="dp-muted">evidenceId</span>
                  <div>
                    <code>{detail.evidenceId}</code>
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
                  <span className="dp-muted">Domain</span>
                  <div>{detail.sourceDomain ?? "—"}</div>
                </div>
                <div>
                  <span className="dp-muted">Group</span>
                  <div>{MANUAL_REVIEW_GROUP_LABELS[classifyQueueItemGroup(detail)]}</div>
                </div>
                <div>
                  <span className="dp-muted">Binding</span>
                  <div>
                    {detail.proposedClassification.subjectBinding}
                    {detail.subjectBindingScore != null ? ` (score ${detail.subjectBindingScore})` : ""}
                  </div>
                </div>
                <div>
                  <span className="dp-muted">Risk / nature / reliability</span>
                  <div>
                    {detail.proposedClassification.riskSignal} ·{" "}
                    {detail.contentNature ?? detail.proposedClassification.contentNature} ·{" "}
                    {detail.sourceReliability ?? "—"}
                  </div>
                </div>
                <div>
                  <span className="dp-muted">Recommended action</span>
                  <div>{detail.recommendedAdminAction}</div>
                </div>
                <div>
                  <span className="dp-muted">Current status</span>
                  <div>
                    <Badge tone={statusTone(String(existingStatus))}>{existingStatus}</Badge>
                  </div>
                </div>
              </div>

              <div>
                <strong>Snippet</strong>
                <p style={{ whiteSpace: "pre-wrap" }}>{detail.snippet}</p>
              </div>
              {detail.subjectBindingExplanation ? (
                <div>
                  <strong>Subject binding explanation</strong>
                  <p>{detail.subjectBindingExplanation}</p>
                </div>
              ) : null}
              {detail.subjectBindingPositiveSignals?.length ? (
                <div>
                  <strong>Positive identity signals</strong>
                  <ul>
                    {detail.subjectBindingPositiveSignals.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {detail.subjectBindingNegativeSignals?.length ? (
                <div>
                  <strong>Negative identity signals</strong>
                  <ul>
                    {detail.subjectBindingNegativeSignals.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div>
                <strong>Why flagged</strong>
                <p>{detail.whyAgentFlagged}</p>
              </div>
              <div>
                <strong>Missing context</strong>
                <ul>
                  {detail.missingContext.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
              <div>
                <strong>Risk interpretation</strong>
                <p>{detail.riskInterpretation}</p>
              </div>
              <div>
                <strong>Neutral interpretation</strong>
                <p>{detail.neutralInterpretation}</p>
              </div>
              {detail.positiveInterpretation ? (
                <div>
                  <strong>Positive interpretation</strong>
                  <p>{detail.positiveInterpretation}</p>
                </div>
              ) : null}

              {canDecide ? (
                <div className="dp-stack" style={{ gap: 10, borderTop: "1px solid #ddd", paddingTop: 12 }}>
                  <h3 style={{ margin: 0 }}>Решение аналитика</h3>
                  {decisionWarning(status) ? <Notice>{decisionWarning(status)!}</Notice> : null}
                  <div className="dp-form-grid">
                    <label className="dp-field">
                      <span>Status</span>
                      <select
                        className="dp-select"
                        value={status}
                        onChange={(e) => setStatus(e.target.value as AdminReviewStatus)}
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="dp-field">
                      <span>Approved client summary</span>
                      <textarea
                        className="dp-input"
                        rows={2}
                        value={approvedClientSummary}
                        onChange={(e) => setApprovedClientSummary(e.target.value)}
                      />
                    </label>
                    <label className="dp-field">
                      <span>Caveat text {status === "APPROVED_WITH_CAVEAT" ? "(обязательно)" : ""}</span>
                      <textarea
                        className="dp-input"
                        rows={2}
                        value={caveatText}
                        onChange={(e) => setCaveatText(e.target.value)}
                      />
                    </label>
                    <label className="dp-field">
                      <span>Reviewer note {status === "WRONG_SUBJECT" ? "(обязательно)" : ""}</span>
                      <textarea
                        className="dp-input"
                        rows={2}
                        value={reviewerNote}
                        onChange={(e) => setReviewerNote(e.target.value)}
                      />
                    </label>
                    <label className="dp-field">
                      <span>Requested sources (по строке)</span>
                      <textarea
                        className="dp-input"
                        rows={2}
                        value={requestedSources}
                        onChange={(e) => setRequestedSources(e.target.value)}
                      />
                    </label>
                  </div>

                  {highImpactSelected && status === "APPROVED" ? (
                    <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <input
                        type="checkbox"
                        checked={highImpactAck}
                        onChange={(e) => setHighImpactAck(e.target.checked)}
                      />
                      <span>
                        Подтверждаю осторожное APPROVED для high-impact материала (compliance / court / adverse /
                        watchlist). Это не автоматическое одобрение системой.
                      </span>
                    </label>
                  ) : null}

                  {existingStatus !== "PENDING" && status !== existingStatus ? (
                    <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <input
                        type="checkbox"
                        checked={overwriteAck}
                        onChange={(e) => setOverwriteAck(e.target.checked)}
                      />
                      <span>
                        Подтверждаю перезапись существующего решения ({existingStatus} → {status}).
                      </span>
                    </label>
                  ) : null}

                  {formError ? <ErrorBox>{formError}</ErrorBox> : null}

                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="dp-btn dp-btn-primary"
                      disabled={submitBusy}
                      onClick={() => void submitDecision()}
                    >
                      {submitBusy ? "Сохранение…" : "Сохранить решение"}
                    </button>
                    <button type="button" className="dp-btn" onClick={() => setSelectedId(null)}>
                      Закрыть
                    </button>
                  </div>
                </div>
              ) : (
                <Notice>Просмотр без права risk.review — решения недоступны.</Notice>
              )}
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
