/**
 * Снимок выдачи Topvisor → строки органики отчёта.
 *
 * Всё — на сырых ответах пилота T0. Что здесь закреплено: номер берётся из
 * ключа снимка (`дата:позиция:индексРегиона`), а не из порядка элементов;
 * регион и движок — из адреса региона, по которому снимок запрашивался, и
 * чужой индекс региона в ключе — отказ, а не «примерно те же строки»; текст
 * запроса — **наш**, а не строчная запись Topvisor; ТОП-20 режем мы, потому
 * что Яндекс отдаёт 50 при любом `depth_positions`.
 */

import { describe, expect, it } from "vitest";
import {
  parseSnapshotKey,
  projectSettingsApplied,
  readCheckPercent,
  snapshotToObservations,
  stripTopvisorHtml,
} from "@/modules/digital-profile/providers/topvisor/adapters/positions";
import { TOPVISOR_AUDIT_REGIONS } from "@/modules/digital-profile/providers/topvisor/regions";
import { TOPVISOR_PROJECT_SETTINGS } from "@/modules/digital-profile/providers/topvisor/project";
import { loadTopvisorFixture } from "@/modules/digital-profile/providers/topvisor/fixtures/fixture-call";

const region = (key: string) => TOPVISOR_AUDIT_REGIONS.find((r) => r.key === key)!;
const PROVENANCE = {
  caseId: "case-1",
  unifiedJobId: "job-1",
  enrichmentRunId: "topvisor-positions-job-1",
  providerTaskId: "pt-1",
  externalTaskId: "32742967:2026-09-03",
};

describe("ключ и разметка снимка", () => {
  it("ключ снимка несёт дату, номер и индекс региона", () => {
    expect(parseSnapshotKey("2026-09-03:7:2520")).toEqual({ date: "2026-09-03", rank: 7, regionIndex: 2520 });
    expect(parseSnapshotKey("мусор")).toBeNull();
  });

  it("разметка Topvisor снимается, сущности раскрываются", () => {
    expect(stripTopvisorHtml("<b>Umar</b> <b>Kremlev</b> &amp; IBA<br>")).toBe("Umar Kremlev & IBA");
  });
});

describe("снимок → наблюдения", () => {
  it("Google Дубай: регион UAE, движок GOOGLE, провайдер несёт движок, запрос — наш", () => {
    const out = snapshotToObservations({
      body: loadTopvisorFixture("read-snapshot-google-dubai"),
      region: region("google-dubai"),
      regionIndex: 2520,
      queries: ["Umar Kremlev boxing", "Umar Kremlev investigation"],
      depth: 20,
      provenance: PROVENANCE,
    });

    expect(out.observations.length).toBeGreaterThan(0);
    for (const o of out.observations) {
      expect(o.region).toBe("UAE");
      expect(o.engine).toBe("GOOGLE");
      expect(o.provider).toBe("topvisor-google");
      expect(o.kind).toBe("organic");
      expect(o.surface).toBe("organic");
      expect(o.providerTaskId).toBe("pt-1");
      expect(o.rank).toBeGreaterThan(0);
      expect(String(o.url)).toMatch(/^https?:\/\//);
      expect(String(o.title ?? "")).not.toMatch(/<b>/);
    }
    // Topvisor пишет фразу строчными; в отчёт идёт наше написание.
    expect(out.observations.map((o) => o.query)).toContain("Umar Kremlev boxing");
    expect(out.observations.map((o) => o.query)).not.toContain("umar kremlev boxing");
    // Первая строка первой фразы — номер 1, из ключа.
    const first = out.observations.find((o) => o.query === "Umar Kremlev boxing" && o.rank === 1);
    expect(first).toBeDefined();
  });

  it("Яндекс Москва: движок YANDEX, регион RU", () => {
    const out = snapshotToObservations({
      body: loadTopvisorFixture("read-snapshot-yandex-moscow"),
      region: region("yandex-moscow"),
      regionIndex: 1,
      queries: ["Умар Кремлёв IBA"],
      depth: 20,
      provenance: PROVENANCE,
    });
    expect(out.observations.length).toBeGreaterThan(0);
    expect(new Set(out.observations.map((o) => o.engine))).toEqual(new Set(["YANDEX"]));
    expect(new Set(out.observations.map((o) => o.region))).toEqual(new Set(["RU"]));
    expect(new Set(out.observations.map((o) => o.provider))).toEqual(new Set(["topvisor-yandex"]));
  });

  it("чужой индекс региона в ключе — ноль строк и предупреждение, а не чужая таблица", () => {
    // Два региона Google с одной фразой различаются только индексом.
    const out = snapshotToObservations({
      body: loadTopvisorFixture("read-snapshot-google-dubai"),
      region: region("google-moscow"),
      regionIndex: 2,
      queries: ["Umar Kremlev boxing"],
      depth: 20,
      provenance: PROVENANCE,
    });
    expect(out.observations).toEqual([]);
    expect(out.warnings.join(" ")).toMatch(/region-index-mismatch/);
  });

  it("ТОП-20 режется адаптером: из 50 строк Яндекса остаются ровно 20, номера 1–20", () => {
    const out = snapshotToObservations({
      body: loadTopvisorFixture("snapshot-yandex-moscow-full-depth"),
      region: region("yandex-moscow"),
      regionIndex: 1,
      queries: ["Кремлёв Умар Назарович"],
      depth: 20,
      provenance: PROVENANCE,
    });
    expect(out.observations).toHaveLength(20);
    expect(out.observations.map((o) => o.rank).sort((a, b) => a! - b!)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1)
    );
  });

  it("фраза не из набора региона отбрасывается и называется", () => {
    // Проект проверяет все фразы во всех регионах; латинская фраза в снимке
    // Яндекса — не строка отчёта, а издержка одного проекта на кейс.
    const out = snapshotToObservations({
      body: loadTopvisorFixture("read-snapshot-yandex-moscow"),
      region: region("yandex-moscow"),
      regionIndex: 1,
      queries: ["Umar Kremlev boxing"],
      depth: 20,
      provenance: PROVENANCE,
    });
    expect(out.observations).toEqual([]);
    expect(out.unmatchedKeywords).toContain("умар кремлёв iba");
  });
});

describe("статус проверки и настройки проекта", () => {
  it("процент проверки читается из ответа проекта", () => {
    expect(readCheckPercent(loadTopvisorFixture("check-status-00"))).toBe(0);
    expect(readCheckPercent(loadTopvisorFixture("check-status-10"))).toBe(100);
    expect(readCheckPercent({ result: [] })).toBeNull();
  });

  it("настройки считаются применёнными только чтением, и недостающая называется", () => {
    const body = loadTopvisorFixture("read-settings");
    expect(projectSettingsApplied(body, TOPVISOR_PROJECT_SETTINGS)).toEqual({ ok: true, missing: [] });
    // Выдуманная настройка пилота: сервис принял её молча, и в проекте её нет.
    expect(projectSettingsApplied(body, { ...TOPVISOR_PROJECT_SETTINGS, ai_snippets: 1 })).toEqual({
      ok: false,
      missing: ["ai_snippets"],
    });
  });
});
