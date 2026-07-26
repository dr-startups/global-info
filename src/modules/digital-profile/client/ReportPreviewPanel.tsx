"use client";

import { useEffect, useState } from "react";
import { getSerpSnapshot, type UnifiedCollectionJobStatus } from "./api";
import { UnifiedCanonicalDownloadButtons } from "./CaseHeader";
import { unifiedArtifactsReady } from "./report-preview-state";
import { EmptyState, Notice, StatusBadge } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";

/**
 * Вкладка «Отчёт»: артефакты текущего прогона и ничего сверх них.
 *
 * Раньше здесь стоял ещё и легаси-контур: выбор шаблона, аудитории, водяного
 * знака и кнопка «Сгенерировать отчёт», а под ней — карточка версии отчёта со
 * ссылками на скачивание. Всё это опиралось на `POST /report/generate` и
 * `POST /report/render`, отставленные на сервере (REMEDIATION 9.3): они
 * отвечают 410 при любых настройках. Значит, версия отчёта никогда не могла
 * стать непустой, а кнопка — сработать. Оператор видел органы управления,
 * которые могли только выдать ошибку (шаг 13, B6).
 *
 * Отчёт кейса — это артефакты unified-прогона, и панель показывает их.
 */
export function ReportPreviewPanel({
  caseId,
  unifiedJob = null,
}: {
  caseId: string;
  /** Прогон, чьи артефакты и есть текущий отчёт кейса. */
  unifiedJob?: UnifiedCollectionJobStatus | null;
}) {
  const { t } = useDigitalProfileI18n();
  // Stage S1.5 — whether a SERP snapshot exists for this case (drives the hint
  // about the ORION-style page being included in the rendered report).
  const [hasSnapshot, setHasSnapshot] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSerpSnapshot(caseId)
      .then((res) => {
        if (!cancelled) setHasSnapshot(!!res.snapshot);
      })
      .catch(() => {
        if (!cancelled) setHasSnapshot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  const unifiedReady = unifiedArtifactsReady(unifiedJob);

  return (
    <div>
      <div className="dp-row" style={{ marginBottom: 16 }}>
        <h2 className="dp-h2" style={{ margin: 0 }}>
          {t("report.title")}
        </h2>
      </div>

      {hasSnapshot !== null ? (
        <div style={{ marginBottom: 14 }}>
          <Notice>
            {hasSnapshot
              ? t("report.serpSnapshotIncluded")
              : t("report.serpSnapshotMissing")}
          </Notice>
        </div>
      ) : null}

      {unifiedReady ? (
        <div style={{ marginBottom: 18 }} data-testid="report-preview-unified">
          <h3 className="dp-h3" style={{ marginTop: 0 }}>
            {t("report.unifiedTitle")}
          </h3>
          <dl className="dp-kv">
            <dt>{t("cases.status")}</dt>
            <dd>
              <StatusBadge status={unifiedJob!.stage} />
            </dd>
            <dt>{t("report.unifiedSource")}</dt>
            <dd className="dp-mono">{unifiedJob!.unifiedJobId || unifiedJob!.jobId}</dd>
          </dl>
          <UnifiedCanonicalDownloadButtons caseId={caseId} job={unifiedJob!} />
        </div>
      ) : (
        <EmptyState title={t("report.emptyTitle")} hint={t("report.emptyHint")} />
      )}
    </div>
  );
}
