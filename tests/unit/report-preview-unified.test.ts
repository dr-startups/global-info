import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unifiedArtifactsReady } from "../../src/modules/digital-profile/client/report-preview-state";
import type { UnifiedCollectionJobStatus } from "../../src/modules/digital-profile/client/api";

/**
 * Шаг 11.5 плана (docs/rework/11-workflow-ux-and-false-failures.md).
 *
 * На кейсе, где прогон завершился REPORT_READY и PDF/PPTX доступны в шапке,
 * вкладка «Предпросмотр отчёта» показывала «Отчёт ещё не сгенерирован» и
 * предлагала нажать «Сгенерировать отчёт» — то есть запустить другой пайплайн
 * вместо того, чтобы открыть уже собранный результат.
 */

function job(over: Partial<UnifiedCollectionJobStatus> = {}): UnifiedCollectionJobStatus {
  return {
    jobId: "j1",
    unifiedJobId: "j1",
    stage: "REPORT_READY",
    status: "COMPLETED",
    ...over,
  } as UnifiedCollectionJobStatus;
}

describe("предпросмотр знает о готовом отчёте прогона", () => {
  it("готовый прогон со ссылками считается отчётом", () => {
    expect(unifiedArtifactsReady(job({ reportLinks: { pdf: "/a.pdf" } }))).toBe(true);
    expect(
      unifiedArtifactsReady(
        job({ downloadArtifacts: { pdf: false, pptx: true, contactSheet: false } })
      )
    ).toBe(true);
  });

  it("частично завершённый прогон с артефактом — тоже отчёт", () => {
    expect(
      unifiedArtifactsReady(job({ stage: "COMPLETED_PARTIAL", reportLinks: { pdf: "/a.pdf" } }))
    ).toBe(true);
  });

  it("идущий прогон отчётом не считается", () => {
    expect(
      unifiedArtifactsReady(job({ stage: "ARSENKIN_ENRICHMENT", reportLinks: { pdf: "/a.pdf" } }))
    ).toBe(false);
  });

  it("завершённый прогон без артефактов отчётом не считается", () => {
    expect(
      unifiedArtifactsReady(
        job({
          reportLinks: {},
          downloadArtifacts: { pdf: false, pptx: false, contactSheet: false },
        })
      )
    ).toBe(false);
    expect(unifiedArtifactsReady(job())).toBe(false);
  });

  it("отсутствие прогона не выдаёт отчёт", () => {
    expect(unifiedArtifactsReady(null)).toBe(false);
  });
});

const CLIENT_DIR = join(process.cwd(), "src/modules/digital-profile/client");
const read = (f: string) => readFileSync(join(CLIENT_DIR, f), "utf8");

describe("проводка прогона до вкладки предпросмотра", () => {
  it("прогон доходит от страницы кейса до панели", () => {
    expect(read("CaseDetailView.tsx")).toMatch(/unifiedJob=\{unifiedJob\}/);
    expect(read("CaseTabs.tsx")).toMatch(/unifiedJob=\{unifiedJob\}/);
  });

  it("пустое состояние не показывается поверх готового отчёта", () => {
    const panel = read("ReportPreviewPanel.tsx");
    expect(panel).toMatch(/unifiedReady \? null : \(/);
    expect(panel).toMatch(/report-preview-unified/);
  });

  it("язык легаси-отчёта не берётся из локали интерфейса", () => {
    // Дека собирается по-русски; подстановка локали UI предлагала язык,
    // которого пайплайн не даёт.
    const panel = read("ReportPreviewPanel.tsx");
    expect(panel).toMatch(/useState<"ru" \| "en">\("ru"\)/);
  });
});

describe("у кейса один статус (шаг 11.3)", () => {
  it("шапка не печатает второй бейдж рядом с первым", () => {
    const header = read("CaseHeader.tsx");
    expect(header).toMatch(/StatusBadge status=\{unifiedLabel \?\? caseDetail\.status\}/);
    expect(header).not.toMatch(/· Unified:/);
  });
});
