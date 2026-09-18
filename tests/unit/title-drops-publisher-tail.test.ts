/**
 * Хвост издания после «·»/«•» — не заголовок (шаг 0117).
 *
 * Отчёт Матвиенко 19.09.2026: «Как живет семья Валентины Матвиенко: сказочные
 * богатства, итальянская вилла и никаких санкций · mirov101.» — аккаунт
 * instagram внутри кавычек. Эталон-72: «… Automecanica SA • Следствие»,
 * «… • Портал РЕПОСТ» — подпись издания внутри цитаты. Сравнение сюжетов
 * (`titleFingerprint`) и так режет по этим знакам; печать обязана делать то же.
 *
 * Тот же заголовок — про отрицание: «никаких санкций» — не сигнал PEP-темы.
 */

import { describe, expect, it } from "vitest";
import {
  quoteForClaim,
  resolveExampleQuote,
  synthesizeFindings,
} from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { getFindingThemes } from "@/modules/digital-profile/config/finding-themes";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import type { SubjectResolutionItem } from "@/modules/digital-profile/orion-golden/contracts/subject-resolution";

const PEP = getFindingThemes().find((t) => t.themeId === "pep_rca_watchlist")!;
const INSTAGRAM =
  "Как живет семья Валентины Матвиенко: сказочные богатства, итальянская вилла и никаких санкций · mirov101.";

describe("хвост издания в заголовке", () => {
  it("Х1: «· mirov101.» и «• Следствие» снимаются", () => {
    expect(quoteForClaim(INSTAGRAM, 220)).toBe(
      "Как живет семья Валентины Матвиенко: сказочные богатства, итальянская вилла и никаких санкций"
    );
    expect(
      quoteForClaim(
        "Russian businessman Sergei Glinka is attempting to gain control of the Popeci defense plant in Moldova through the Romanian company Automecanica SA • Следствие",
        220
      )
    ).toBe(
      "Russian businessman Sergei Glinka is attempting to gain control of the Popeci defense plant in Moldova through the Romanian company Automecanica SA"
    );
  });

  it("Х2: короткий остаток не режется — это не хвост, а часть заголовка", () => {
    expect(quoteForClaim("Интервью · Матвиенко о санкциях", 220)).toBe("Интервью · Матвиенко о санкциях");
  });
});

describe("отрицание перед словом темы — не сигнал", () => {
  const item: RawInventoryItem = {
    inventoryId: "insta",
    caseId: "case-matvienko",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "topvisor-yandex",
    region: "RU",
    collectedAt: "2026-09-18T12:00:00.000Z",
    evidenceType: "search_result",
    title: INSTAGRAM,
    snippet: "",
    sourceUrl: "https://www.instagram.com/p/abc123/",
  };

  it("О2: «никаких санкций» не даёт PEP-темы и не даёт цитаты PEP", () => {
    const result = synthesizeFindings({
      caseId: "case-matvienko",
      datasetId: "ds-1",
      items: [item],
      resolutionByRef: new Map([
        ["inventory:insta", { evidenceRef: "inventory:insta", decision: "SUBJECT_MATCH" } as SubjectResolutionItem],
      ]),
      sourceHashes: [],
      subjectNames: ["Матвиенко Валентина Ивановна"],
    });
    expect(result.themeAssignments.get("inventory:insta") ?? []).not.toContain("pep_rca_watchlist");
    expect(
      resolveExampleQuote(item, PEP, null, { subjectNames: ["Матвиенко Валентина Ивановна"] })
    ).toBeNull();
  });
});
