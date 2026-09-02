import { describe, expect, it } from "vitest";
import {
  LINK_VERDICT_SCHEMA_VERSION,
  LinkVerdictSchema,
  requireQuotedAdverse,
  summarizeLinkVerdicts,
  type LinkVerdict,
} from "@/modules/digital-profile/orion-golden/contracts/link-verdict";

function verdict(partial: Partial<LinkVerdict> & { url: string }): LinkVerdict {
  return LinkVerdictSchema.parse({
    schemaVersion: LINK_VERDICT_SCHEMA_VERSION,
    evidenceRef: `inventory:${partial.url}`,
    subjectMatch: "subject",
    tone: "neutral",
    theme: "Деловой профиль",
    quotes: [],
    readAt: "2026-08-13T12:00:00.000Z",
    ...partial,
  });
}

describe("свод решений по ссылкам", () => {
  it("суммы по темам сходятся с числом нежелательных ссылок", () => {
    // Свойство эталона: 24 + 21 + 7 + 4 + 2 = 58 — ровно столько же, сколько
    // нежелательных ссылок в метрике выше. Числа, не сходящиеся между
    // страницами отчёта, читаются как выдуманные.
    const verdicts = [
      verdict({ url: "a", tone: "adverse", theme: "Санкционные списки", quotes: [{ text: "включён в санкционный список" }] }),
      verdict({ url: "b", tone: "adverse", theme: "Санкционные списки", quotes: [{ text: "заморожены активы по решению" }] }),
      verdict({ url: "c", tone: "adverse", theme: "Судебный спор с бывшей супругой", quotes: [{ text: "иск подан в суд Лондона" }] }),
      verdict({ url: "d", tone: "neutral", theme: "Деловой профиль" }),
    ];
    const s = summarizeLinkVerdicts(verdicts);
    expect(s.adverse).toBe(3);
    expect(s.themes.reduce((n, t) => n + t.adverseCount, 0)).toBe(s.adverse);
  });

  it("темы идут по числу нежелательных публикаций", () => {
    const verdicts = [
      verdict({ url: "a", tone: "adverse", theme: "Одна тема", quotes: [{ text: "основание для первой темы" }] }),
      verdict({ url: "b", tone: "adverse", theme: "Другая тема", quotes: [{ text: "основание для второй темы" }] }),
      verdict({ url: "c", tone: "adverse", theme: "Другая тема", quotes: [{ text: "второе основание для второй" }] }),
    ];
    expect(summarizeLinkVerdicts(verdicts).themes.map((t) => t.theme)).toEqual([
      "Другая тема",
      "Одна тема",
    ]);
  });

  it("материал о другом человеке не подтверждает тему субъекта", () => {
    const verdicts = [
      verdict({ url: "a", subjectMatch: "other", tone: "adverse", theme: "Уголовное дело", quotes: [{ text: "приговор вынесен однофамильцу" }] }),
      verdict({ url: "b", tone: "neutral", theme: "Деловой профиль" }),
    ];
    const s = summarizeLinkVerdicts(verdicts);
    expect(s.adverse).toBe(0);
    expect(s.themes.map((t) => t.theme)).toEqual(["Деловой профиль"]);
    expect(s.total).toBe(2);
  });

  it("непрочитанные страницы считаются отдельно, а не исчезают", () => {
    const verdicts = [
      verdict({ url: "a", readFailure: "blocked" }),
      verdict({ url: "b", readFailure: "timeout" }),
      verdict({ url: "c" }),
    ];
    expect(summarizeLinkVerdicts(verdicts).unread).toBe(2);
  });

  it("примеры темы идут в порядке позиции в выдаче", () => {
    const verdicts = [
      verdict({ url: "низкая", rank: 12, tone: "adverse", theme: "Тема", quotes: [{ text: "основание для темы номер" }] }),
      verdict({ url: "верхняя", rank: 2, tone: "adverse", theme: "Тема", quotes: [{ text: "другое основание для темы" }] }),
    ];
    expect(summarizeLinkVerdicts(verdicts).themes[0]?.examples.map((e) => e.url)).toEqual([
      "верхняя",
      "низкая",
    ]);
  });
});

describe("вывод без основания", () => {
  it("нежелательный вывод без цитаты понижается до неясного", () => {
    const raw = verdict({ url: "a", tone: "adverse", theme: "Коррупционные связи" });
    const checked = requireQuotedAdverse(raw);
    expect(checked.tone).toBe("neutral");
    expect(checked.subjectMatch).toBe("unclear");
  });

  it("нежелательный вывод с цитатой сохраняется как есть", () => {
    const raw = verdict({
      url: "a",
      tone: "adverse",
      theme: "Коррупционные связи",
      quotes: [{ text: "в материале приводится схема вывода средств" }],
    });
    expect(requireQuotedAdverse(raw)).toEqual(raw);
  });

  it("нейтральный вывод цитаты не требует", () => {
    const raw = verdict({ url: "a", tone: "neutral", theme: "Деловой профиль" });
    expect(requireQuotedAdverse(raw)).toEqual(raw);
  });
});
