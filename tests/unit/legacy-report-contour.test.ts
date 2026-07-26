import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Шаг 13, этап 5 (docs/rework/13-regression-run-findings.md, B6).
 *
 * Легаси-контур отчёта отставлен на сервере (REMEDIATION 9.3): `GET /report`,
 * `POST /report/generate`, `/report/render`, `/report/orion-v2` и
 * `/report/orion-client-storyboard` отвечают `410 Gone` при любых настройках.
 * Клиент их всё ещё вызывал: `GET /report` — при каждом открытии кейса, а
 * остальные по кнопкам, которые не могли сработать ни при каких условиях.
 * Оператор получал ошибку в консоли на каждом открытии и органы управления,
 * умеющие только падать.
 *
 * Условия, при которых маршрут ожил бы, не существует, поэтому проверка
 * буквальная: обращений к этим адресам в клиенте быть не должно.
 */

const CLIENT_DIR = join(process.cwd(), "src/modules/digital-profile/client");

/** Обращение к отставленному маршруту: адрес в шаблонной строке запроса. */
const RETIRED_CALL =
  /`\/cases\/\$\{caseId\}\/report(?:`|\/(?:generate|render|orion-v2|orion-client-storyboard))/u;

function clientSources(): Array<{ file: string; text: string }> {
  return readdirSync(CLIENT_DIR)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((f) => ({ file: f, text: readFileSync(join(CLIENT_DIR, f), "utf8") }));
}

describe("клиент не обращается к отставленным маршрутам отчёта", () => {
  it("ни один файл клиента не вызывает отставленный адрес", () => {
    const offenders = clientSources()
      .filter((s) => RETIRED_CALL.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it("проверка ловит обращение, если оно вернётся", () => {
    // Иначе тест выше зелен по любой причине, включая сломанное выражение.
    expect(RETIRED_CALL.test("request<X>(`/cases/${caseId}/report`)")).toBe(true);
    expect(RETIRED_CALL.test("request<X>(`/cases/${caseId}/report/generate`, {")).toBe(true);
    expect(RETIRED_CALL.test("request<X>(`/cases/${caseId}/report/orion-v2`)")).toBe(true);
  });

  it("живые соседние маршруты проверка не задевает", () => {
    // Выгрузки прогона и SERP-снимки к отставленному контуру не относятся.
    expect(RETIRED_CALL.test("request<X>(`/cases/${caseId}/report-runs/${id}/serp-captures`)")).toBe(
      false
    );
    expect(RETIRED_CALL.test("request<X>(`/cases/${caseId}/unified-collection/download`)")).toBe(
      false
    );
    expect(RETIRED_CALL.test("request<X>(`/cases/${caseId}/orion-golden/report/download`)")).toBe(
      false
    );
  });

  it("панель отчёта показывает артефакты прогона, а не легаси-версию", () => {
    const panel = readFileSync(join(CLIENT_DIR, "ReportPreviewPanel.tsx"), "utf8");
    expect(panel).not.toMatch(/generateReport|renderReport|ReportVersion/u);
    expect(panel).toMatch(/UnifiedCanonicalDownloadButtons/u);
  });
});

/**
 * Маршруты остаются надгробиями: их удаление превратило бы честный `410 Gone`
 * («путь отставлен, вот актуальный») в `404` для любого внешнего клиента,
 * который ещё их знает. Проверка унаследована от смока
 * `smoke-orion-ui-integration-r95`, снятого вместе с ORION v2 UI: панелей,
 * которые он сторожил, не существует, а эта его часть осмысленна.
 */
const API_DIR = join(process.cwd(), "src/app/api/digital-profile/cases/[id]/report");

describe("отставленные маршруты остаются надгробиями", () => {
  it.each([
    "route.ts",
    "generate/route.ts",
    "render/route.ts",
    "orion-v2/route.ts",
    "orion-client-storyboard/route.ts",
  ])("%s отвечает через legacyReportPathRetired", (rel) => {
    expect(readFileSync(join(API_DIR, rel), "utf8")).toContain("legacyReportPathRetired");
  });

  it("проверка доступа на GET /report сохранена", () => {
    // Отставленный путь всё ещё сообщает о существовании кейса, поэтому
    // отвечать на него без проверки доступа нельзя.
    const route = readFileSync(join(API_DIR, "route.ts"), "utf8");
    expect(route).toContain('requireRole(user, "evidence.viewRaw")');
    expect(route).toContain("requireCaseAccess");
  });
});
