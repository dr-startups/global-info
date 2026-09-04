import { describe, expect, it } from "vitest";
import { auditLinkVerdicts } from "@/modules/digital-profile/orion-golden/analytics/link-verdict-audit-agent";
import {
  LINK_VERDICT_SCHEMA_VERSION,
  LinkVerdictSchema,
  type LinkVerdict,
} from "@/modules/digital-profile/orion-golden/contracts/link-verdict";
import type { SubjectAnchors } from "@/modules/digital-profile/orion-golden/analytics/subject-anchors";

/**
 * «Это он» на прочитанной странице требует признака в самом тексте.
 *
 * Стадия чтения знала о субъекте только ФИО и на прогоне DPA-2026-0049 назвала
 * страницами субъекта тринадцать карточек ИП и четыре страницы офтальмолога —
 * из них собраны «Основные сюжеты в выдаче» второй страницы отчёта. Имя на
 * странице есть у каждого полного тёзки; признак — нет.
 */

const ANCHORS: SubjectAnchors = {
  birthDate: "1977-11-30",
  phrases: [{ kind: "employer", text: "Арбитражный суд Краснодарского края", strong: true }],
  inn: [],
  domains: [],
};

function verdict(over: Partial<LinkVerdict> = {}): LinkVerdict {
  return LinkVerdictSchema.parse({
    schemaVersion: LINK_VERDICT_SCHEMA_VERSION,
    evidenceRef: "inventory:1",
    url: "https://example.org/a",
    subjectMatch: "subject",
    tone: "neutral",
    theme: "Назначение председателя суда",
    sourceType: "news",
    quotes: [],
    readAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });
}

const NAME_ONLY =
  "Егоров Алексей Евгеньевич зарегистрирован как индивидуальный предприниматель в Мончегорске.";
const WITH_ANCHOR =
  "Председателем Арбитражного суда Краснодарского края назначен Егоров Алексей Евгеньевич.";

function audit(text: string, anchors?: SubjectAnchors) {
  return auditLinkVerdicts({
    verdicts: [verdict()],
    sources: [{ evidenceRef: "inventory:1", text }],
    subjectNames: ["Егоров Алексей Евгеньевич", "Егоров"],
    anchors,
  });
}

describe("проверка выводов знает о признаках субъекта", () => {
  it("признака в тексте нет — «это он» снимается", () => {
    const out = audit(NAME_ONLY, ANCHORS);
    expect(out.verdicts[0]?.subjectMatch).toBe("unclear");
    expect(out.report.subjectDowngraded).toBe(1);
    expect(out.report.changes[0]?.action).toBe("anchor_missing");
    expect(out.report.changes[0]?.reason).toContain("признак");
  });

  it("признак на странице есть — решение не трогается", () => {
    const out = audit(WITH_ANCHOR, ANCHORS);
    expect(out.verdicts[0]?.subjectMatch).toBe("subject");
    expect(out.report.subjectDowngraded).toBe(0);
  });

  it("дата рождения на странице тоже подтверждает", () => {
    const out = audit(`Егоров Алексей Евгеньевич, родился 30.11.1977, судья.`, ANCHORS);
    expect(out.verdicts[0]?.subjectMatch).toBe("subject");
  });

  it("признаков не назвали — прежнее поведение слово в слово", () => {
    const out = audit(NAME_ONLY);
    expect(out.verdicts[0]?.subjectMatch).toBe("subject");
    expect(out.report.subjectDowngraded).toBe(0);
    expect(out.report.changes).toEqual([]);
  });

  it("«вероятно» под признаки не подводится: оно и не утверждает принадлежность", () => {
    const out = auditLinkVerdicts({
      verdicts: [verdict({ subjectMatch: "likely" })],
      sources: [{ evidenceRef: "inventory:1", text: NAME_ONLY }],
      subjectNames: ["Егоров Алексей Евгеньевич", "Егоров"],
      anchors: ANCHORS,
    });
    expect(out.verdicts[0]?.subjectMatch).toBe("likely");
  });
});
