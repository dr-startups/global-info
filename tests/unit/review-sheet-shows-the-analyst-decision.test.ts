/**
 * Лист проверки показывает решение аналитика и знает, что оно новее документа.
 *
 * Пункт с отвеченной принадлежностью открытым больше не считается — иначе счёт
 * открытых никогда не сходился бы и «выпустить при N открытых» ничего не
 * значило бы. А решение, принятое после сборки, обязано быть отличимо от
 * вошедшего в документ: иначе аналитик видит своё решение в списке и не
 * понимает, почему его нет в PDF.
 */

import { describe, expect, it } from "vitest";
import {
  applyDecisionsToSheet,
  buildReviewSheet,
} from "@/modules/digital-profile/services/review-sheet";

const CASE_ID = "case-1";
const KEY = "url:zakrasnodar.ru/art/villa.html";

const INPUT = {
  caseId: CASE_ID,
  slides: [
    {
      slideKey: "p09_ru_serp_table",
      baseSlotId: "p09_ru_serp_table",
      templateId: "serp-table",
      pageNumber: 15,
      title: "Россия — результаты поисковой выдачи",
      evidenceRefs: ["inventory:obs-a", "inventory:obs-b"],
    },
  ],
  observations: [
    {
      url: "https://zakrasnodar.ru/art/villa.html",
      title: "На мысе Агрия образовалась вилла матери судьи",
      domain: "zakrasnodar.ru",
      evidenceRefs: ["inventory:obs-a"],
    },
    {
      url: "https://zakrasnodar.ru/art/villa.html?utm_source=x",
      title: "На мысе Агрия образовалась вилла матери судьи",
      domain: "zakrasnodar.ru",
      evidenceRefs: ["inventory:obs-b"],
    },
  ],
  subjectResolution: [
    { evidenceRef: "inventory:obs-a", decision: "AMBIGUOUS", reasonCode: "mixed_identity_signals" },
    { evidenceRef: "inventory:obs-b", decision: "AMBIGUOUS", reasonCode: "mixed_identity_signals" },
  ],
};

describe("лист проверки и решения аналитика", () => {
  it("без решения пункт открыт", () => {
    const sheet = buildReviewSheet(INPUT);
    const item = sheet.items.find((i) => i.kind === "evidence")!;
    expect(item.key).toBe(KEY);
    expect(item.open).toBe(true);
    expect(item.decisions).toBeUndefined();
  });

  it("отвеченная принадлежность закрывает пункт и названа в нём", () => {
    const sheet = buildReviewSheet({
      ...INPUT,
      decisions: [
        {
          itemKind: "evidence",
          itemKey: KEY,
          decisionKind: "belonging",
          status: "CONFIRMED_SUBJECT",
          decidedBy: "analyst-1",
          decidedAt: "2026-09-07T10:00:00.000Z",
        },
      ],
    });
    const item = sheet.items.find((i) => i.kind === "evidence")!;
    expect(item.open).toBe(false);
    expect(item.decisions?.belonging?.status).toBe("CONFIRMED_SUBJECT");
    expect(item.decisions?.belonging?.decidedBy).toBe("analyst-1");
    expect(sheet.summary.evidence.open).toBe(0);
  });

  it("решение о негативе принадлежность не закрывает", () => {
    const sheet = buildReviewSheet({
      ...INPUT,
      decisions: [
        {
          itemKind: "evidence",
          itemKey: KEY,
          decisionKind: "adverse",
          status: "NEUTRAL",
          decidedAt: "2026-09-07T10:00:00.000Z",
        },
      ],
    });
    const item = sheet.items.find((i) => i.kind === "evidence")!;
    expect(item.open).toBe(true);
    expect(item.decisions?.adverse?.status).toBe("NEUTRAL");
  });

  it("наложение решений на готовый лист даёт тот же ответ, что сборка с ними", () => {
    const decisions = [
      {
        itemKind: "evidence",
        itemKey: KEY,
        decisionKind: "belonging",
        status: "CONFIRMED_SUBJECT",
        decidedBy: "analyst-1",
        decidedAt: "2026-09-07T10:00:00.000Z",
      },
    ];
    const built = buildReviewSheet({ ...INPUT, decisions });
    const overlaid = applyDecisionsToSheet(buildReviewSheet(INPUT), decisions);
    expect(overlaid.items.map((i) => ({ key: i.key, open: i.open, d: i.decisions }))).toEqual(
      built.items.map((i) => ({ key: i.key, open: i.open, d: i.decisions }))
    );
    expect(overlaid.summary.evidence.open).toBe(0);

    // Снятое решение возвращает машинную открытость дословно.
    const cleared = applyDecisionsToSheet(overlaid, []);
    expect(cleared.items[0]!.open).toBe(true);
    expect(cleared.items[0]!.decisions).toBeUndefined();
  });

  it("лист несёт отпечаток решений, вошедших в документ", () => {
    const withNone = buildReviewSheet(INPUT);
    const withOne = buildReviewSheet({
      ...INPUT,
      decisions: [
        {
          itemKind: "evidence",
          itemKey: KEY,
          decisionKind: "belonging",
          status: "CONFIRMED_SUBJECT",
          decidedAt: "2026-09-07T10:00:00.000Z",
        },
      ],
    });
    expect(withOne.decisionsDigest).not.toBe(withNone.decisionsDigest);
    expect(typeof withNone.decisionsDigest).toBe("string");
  });
});
