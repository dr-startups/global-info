import { describe, expect, it } from "vitest";
import {
  auditLinkVerdicts,
  quoteFoundInText,
  subjectMentioned,
  verdictAuditLogLine,
} from "@/modules/digital-profile/orion-golden/analytics/link-verdict-audit-agent";
import type { LinkVerdict } from "@/modules/digital-profile/orion-golden/contracts/link-verdict";

const PAGE =
  "Иванов Иван Иванович выступил на конференции. " +
  "Суд удовлетворил иск заявителя по делу о взыскании задолженности. " +
  "Далее следует обычный текст публикации.";

function verdict(over: Partial<LinkVerdict> = {}): LinkVerdict {
  return {
    schemaVersion: "link-verdict-v1",
    evidenceRef: "inventory:1",
    url: "https://example.org/a",
    subjectMatch: "subject",
    tone: "neutral",
    theme: "Деловая публикация о субъекте",
    quotes: [],
    readAt: "2026-08-14T10:00:00.000Z",
    ...over,
  } as LinkVerdict;
}

const SOURCES = [{ evidenceRef: "inventory:1", text: PAGE }];
const NAMES = ["Иванов Иван Иванович", "Иванов"];

describe("сверка цитаты с текстом страницы", () => {
  it("настоящая цитата принимается, несмотря на кавычки и тире", () => {
    expect(quoteFoundInText("«Суд удовлетворил иск заявителя»", PAGE)).toBe(true);
  });

  it("выдуманной цитаты в тексте нет", () => {
    expect(quoteFoundInText("Суд признал его виновным в мошенничестве", PAGE)).toBe(false);
  });

  it("слишком короткий обрывок цитатой не считается", () => {
    expect(quoteFoundInText("Суд", PAGE)).toBe(false);
  });
});

describe("упоминание субъекта", () => {
  it("узнаётся по фамилии", () => {
    expect(subjectMentioned(PAGE, NAMES)).toBe(true);
  });

  it("на чужой странице субъекта нет", () => {
    expect(subjectMentioned("Материал о совершенно другом человеке.", NAMES)).toBe(false);
  });
});

describe("проверка решений", () => {
  it("нежелательный вывод с выдуманной цитатой понижается", () => {
    const { verdicts, report } = auditLinkVerdicts({
      verdicts: [
        verdict({
          tone: "adverse",
          quotes: [{ text: "Суд признал его виновным в мошенничестве" }],
        }),
      ],
      sources: SOURCES,
      subjectNames: NAMES,
    });
    expect(verdicts[0]!.tone).toBe("neutral");
    expect(verdicts[0]!.quotes).toHaveLength(0);
    expect(report.quotesDropped).toBe(1);
    expect(report.adverseDowngraded).toBe(1);
    expect(report.changes.map((c) => c.action)).toEqual(["quote_dropped", "adverse_downgraded"]);
  });

  it("нежелательный вывод с настоящей цитатой остаётся", () => {
    const { verdicts, report } = auditLinkVerdicts({
      verdicts: [
        verdict({
          tone: "adverse",
          quotes: [{ text: "Суд удовлетворил иск заявителя по делу о взыскании" }],
        }),
      ],
      sources: SOURCES,
      subjectNames: NAMES,
    });
    expect(verdicts[0]!.tone).toBe("adverse");
    expect(report.adverseDowngraded).toBe(0);
    expect(report.quotesDropped).toBe(0);
  });

  it("«это он» без имени на странице понижается до неясного", () => {
    const { verdicts, report } = auditLinkVerdicts({
      verdicts: [verdict({ subjectMatch: "subject" })],
      sources: [{ evidenceRef: "inventory:1", text: "Страница о другом человеке целиком." }],
      subjectNames: NAMES,
    });
    expect(verdicts[0]!.subjectMatch).toBe("unclear");
    expect(report.subjectDowngraded).toBe(1);
  });

  it("непрочитанная страница не проверяется и не портится", () => {
    const input = verdict({ subjectMatch: "unclear", readFailure: "blocked" });
    const { verdicts, report } = auditLinkVerdicts({
      verdicts: [input],
      sources: [{ evidenceRef: "inventory:1", text: undefined }],
      subjectNames: NAMES,
    });
    expect(verdicts[0]).toBe(input);
    expect(report.checked).toBe(0);
  });

  it("каждое изменение объяснено", () => {
    const { report } = auditLinkVerdicts({
      verdicts: [verdict({ tone: "adverse", quotes: [{ text: "Совершенно выдуманная фраза здесь" }] })],
      sources: SOURCES,
      subjectNames: NAMES,
    });
    for (const change of report.changes) {
      expect(change.reason.length).toBeGreaterThan(10);
      expect(change.url).toBe("https://example.org/a");
    }
  });
});

describe("строка в лог", () => {
  it("называет, что именно снято", () => {
    const line = verdictAuditLogLine({
      checked: 87,
      quotesDropped: 3,
      adverseDowngraded: 2,
      subjectDowngraded: 1,
      changes: [],
    });
    expect(line).toContain("проверено решений: 87");
    expect(line).toContain("снято непроверяемых цитат: 3");
    expect(line).toContain("понижено нежелательных: 2");
  });

  it("без прочитанных страниц так и говорит", () => {
    expect(
      verdictAuditLogLine({
        checked: 0,
        quotesDropped: 0,
        adverseDowngraded: 0,
        subjectDowngraded: 0,
        changes: [],
      })
    ).toContain("проверять нечего");
  });
});

describe("узнавание имени в тексте страницы", () => {
  /**
   * Разбор прогона: проверка искала ФИО целиком и отвергла 47 решений из 92 —
   * страницы пишут «Герман Греф» или просто «Греф», а не «Греф Герман
   * Оскарович» подряд. Материал терялся не потому, что он о другом человеке.
   */
  const NAMES_FULL = ["Греф Герман Оскарович"];

  it("узнаёт по фамилии, когда порядок слов другой", () => {
    expect(subjectMentioned("Герман Греф выступил на форуме.", NAMES_FULL)).toBe(true);
  });

  it("узнаёт фамилию и в косвенном падеже", () => {
    // Сравнение по вхождению — не небрежность, а нужное свойство: русская
    // фамилия склоняется, и «Грефа» в тексте это тот же человек.
    expect(subjectMentioned("По словам Грефа, банк готовит новый сервис.", NAMES_FULL)).toBe(true);
    expect(subjectMentioned("Греф возглавляет банк с 2007 года.", NAMES_FULL)).toBe(true);
  });

  it("страница без единого упоминания не проходит", () => {
    expect(subjectMentioned("Материал о совершенно другом человеке.", NAMES_FULL)).toBe(false);
  });

  it("короткие частицы имени якорем не служат", () => {
    // «ван» из «ван Дейк» не должно совпасть со словом «ванная».
    expect(subjectMentioned("В доме была ванная комната.", ["ван Дейк"])).toBe(false);
  });
});
