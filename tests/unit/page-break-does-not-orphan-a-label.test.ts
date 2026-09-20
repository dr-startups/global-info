/**
 * Граница листа не отрывает ярлык от его тела (шаг 0134).
 *
 * Стр. 7 отчёта Мордашова 20.09.2026 кончается строкой «OFAC / sanctions
 * list.», а стр. 8 начинается её продолжением: «По открытым/импортированным
 * данным есть сигнал, связанный с записью „What Is Russian Oligarch Alexei
 * Mordashov's Net Worth?“.» Тремя записями выше ярлык и тело стоят одной
 * строкой — разорвала их укладка, когда тело не влезло в лист.
 *
 * Правило: короткий хвост не кончает кусок в одиночку. Он уезжает вместе с
 * тем, что за ним следует: название источника без своего утверждения не
 * значит ничего, и читатель видит обрыв.
 */

import { describe, expect, it } from "vitest";
import { packSentencesNoTruncate } from "@/modules/digital-profile/orion-golden/deck-sections/semantic-summary-pagination";

const RECORD = (name: string, what: string) =>
  `${name}. По открытым/импортированным данным есть сигнал, связанный с записью «${what}».\n` +
  "Официальная/реестровая запись; сверить актуальность статуса по первоисточнику.";

/** Блок «Международные базы» резюме — дословно с живого прогона. */
const DATABASES = [
  "Международные базы и официальные источники",
  RECORD("OFAC / sanctions list", "ИП Мордашов Алексей Александрович (ИНН 352806209266)"),
  RECORD("opensanctions.org", "Alexey Alexandrovits Mordaschov"),
  RECORD("peps.dossier.center", "Алексей Мордашов - Досье» - PEPS"),
  RECORD("OFAC / sanctions list", "What Is Russian Oligarch Alexei Mordashov's Net Worth?"),
].join("\n");

describe("укладка предложений", () => {
  it("Р1: ярлык не остаётся последним в куске", () => {
    const chunks = packSentencesNoTruncate(DATABASES, 700, { keepLines: true });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.trim()).not.toMatch(/(?:^|[.!?]\s)[^.!?]{1,40}\.$/u);
    }
  });

  it("Р2: ярлык уехал вместе со своим телом", () => {
    const chunks = packSentencesNoTruncate(DATABASES, 700, { keepLines: true });
    const withLabel = chunks.find((c) => c.includes("What Is Russian Oligarch"));
    expect(withLabel).toBeDefined();
    expect(withLabel).toContain("OFAC / sanctions list.");
  });

  it("Р3: короткий текст одним куском остаётся как есть", () => {
    expect(packSentencesNoTruncate("Короткая фраза о субъекте.", 320)).toEqual([
      "Короткая фраза о субъекте.",
    ]);
  });

  it("Р4: единственное короткое предложение куском быть может", () => {
    const chunks = packSentencesNoTruncate("Первое очень длинное предложение, которое занимает почти весь бюджет листа целиком и не оставляет места. Коротко.", 110);
    expect(chunks.join(" ")).toContain("Коротко.");
  });
});
