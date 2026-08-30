/**
 * Решение аналитика доезжает до индекса доказательств — и только там, где оно есть.
 *
 * Решение живёт в аудиторском следе прогона (`analytics/analyst-overrides-applied.json`),
 * а дека собиралась из наблюдений и решений по прочитанным страницам и о нём
 * не знала: явный `ADVERSE_MEDIA`, поставленный человеком, до клиента не
 * доезжал, а явный `NEUTRAL` деку не останавливал.
 *
 * Три условия, каждое проверяется отдельно: файла может не быть вовсе (реплей
 * старого прогона); решение принадлежит материалу, а не наблюдению; правка о
 * принадлежности («это однофамилец») решением о негативе не подменяется —
 * это ответ на другой вопрос, и он едет своим путём.
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  applyAnalystDecisionsToEvidence,
  loadDeckInputsFromAnalyticsDir,
} from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

function index(): ScopedEvidenceIndex {
  return {
    "inventory:obs-a": {
      title: "Anders Holmström, CEO of Nordkap Capital AB — fintech investor profile",
      domain: "finansbladet.se",
      url: "https://finansbladet.se/a",
      region: "RU",
    },
    // Тот же материал, найденный вторым запросом: адрес тот же, различается
    // только написание — ключ материала читает адрес.
    "inventory:obs-a-second-query": {
      title: "Anders Holmström, CEO of Nordkap Capital AB — fintech investor profile",
      domain: "finansbladet.se",
      url: "http://www.finansbladet.se/a/",
      region: "RU",
    },
    // Тот же сайт, другой материал.
    "inventory:obs-b": {
      title: "Nordkap Capital opens a Stockholm office",
      domain: "finansbladet.se",
      url: "https://finansbladet.se/b",
      region: "RU",
    },
  };
}

describe("решение аналитика раскладывается по материалу", () => {
  it("решение стоит на всех ссылках своего материала", () => {
    const evidence = index();
    applyAnalystDecisionsToEvidence(evidence, [
      { kind: "classification_adverse", matchKey: "searchResult:sr-3", inventoryId: "obs-a", effect: "" },
    ]);
    expect(evidence["inventory:obs-a"]!.analystDecision).toBe("ADVERSE");
    expect(evidence["inventory:obs-a-second-query"]!.analystDecision).toBe("ADVERSE");
  });

  it("и ни на одной чужой", () => {
    const evidence = index();
    applyAnalystDecisionsToEvidence(evidence, [
      { kind: "classification_adverse", matchKey: "searchResult:sr-3", inventoryId: "obs-a", effect: "" },
    ]);
    expect(evidence["inventory:obs-b"]!.analystDecision).toBeUndefined();
  });

  it("«нейтральный» и «снято при ручной проверке» — то же решение", () => {
    const evidence = index();
    applyAnalystDecisionsToEvidence(evidence, [
      { kind: "classification_neutral", matchKey: "k1", inventoryId: "obs-a", effect: "" },
      { kind: "manual_review_excluded", matchKey: "k2", inventoryId: "obs-b", effect: "" },
    ]);
    expect(evidence["inventory:obs-a"]!.analystDecision).toBe("NEUTRAL");
    expect(evidence["inventory:obs-b"]!.analystDecision).toBe("NEUTRAL");
  });

  it("правка о принадлежности решением о негативе не становится", () => {
    const evidence = index();
    applyAnalystDecisionsToEvidence(evidence, [
      { kind: "identity_other_subject", matchKey: "k1", inventoryId: "obs-a", effect: "" },
      { kind: "manual_review_wrong_subject", matchKey: "k2", inventoryId: "obs-b", effect: "" },
      { kind: "approved_finding", matchKey: "k3", inventoryId: "obs-a", effect: "" },
    ]);
    for (const ref of Object.keys(evidence)) {
      expect(evidence[ref]!.analystDecision).toBeUndefined();
    }
  });

  it("запись без идентификатора инвентаря ничего не ставит", () => {
    const evidence = index();
    applyAnalystDecisionsToEvidence(evidence, [
      { kind: "classification_adverse", matchKey: "searchResult:sr-9", effect: "" },
    ]);
    for (const ref of Object.keys(evidence)) {
      expect(evidence[ref]!.analystDecision).toBeUndefined();
    }
  });

  it("пустой список решений индекс не трогает", () => {
    const evidence = index();
    const before = JSON.stringify(evidence);
    applyAnalystDecisionsToEvidence(evidence, []);
    expect(JSON.stringify(evidence)).toBe(before);
  });
});

describe("отсутствие файла решений — не решение", () => {
  it("прогон без аудиторского следа читается и не помечает ничего", () => {
    // `report-72` собран до появления файла: его каталог артефактов — ровно
    // тот случай, ради которого чтение необязательное.
    const inputs = loadDeckInputsFromAnalyticsDir(
      join(process.cwd(), "baselines", "report-72", "artifacts", "analytics")
    );
    const marked = Object.values(inputs.evidenceIndex).filter((e) => e.analystDecision);
    expect(marked).toHaveLength(0);
  });
});
