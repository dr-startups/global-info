import { describe, expect, it } from "vitest";
import {
  adaptWikipediaCheckToInventoryItem,
  resolveEvidenceSupplement,
} from "@/modules/digital-profile/services/evidence-supplement-adapter";
import {
  buildSubjectResolution,
  subjectIdentityFromProfile,
} from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

/**
 * Подтверждённость принадлежности не чеканится из самого факта «статья есть».
 *
 * Адаптер ставил каждой записи проверки `identityFromReview: true` и
 * `reviewStatus: exists ? "MATCH_CONFIRMED" : "PENDING"`, а классификатор по
 * этой мете отдавал `SUBJECT_MATCH @0.95 compliance_match_confirmed`. То есть
 * «принадлежность подтверждена» выводилась из того же `exists`, который она
 * обязана проверять: инструмент, создающий дефект, измерял сам себя, и ветка
 * тёзки на живом пути была недостижима при живых юнитах.
 *
 * Ответчик один — классификатор по тексту заголовка. Статья, найденная по
 * межъязыковой ссылке, наследует решение статьи-источника: это та же сущность,
 * и двух ответов о ней быть не может.
 */

const SUBJECT = subjectIdentityFromProfile({
  displayName: "Михаил Глинка",
  givenNames: ["Михаил"],
  familyNames: ["Глинка"],
  patronymics: ["Иванович"],
});

function checkItem(row: {
  id: string;
  exists: boolean;
  language: string;
  pageTitle?: string | null;
  url?: string | null;
  foundVia?: string | null;
  langlinkOf?: { language: string; title: string } | null;
}): RawInventoryItem {
  return adaptWikipediaCheckToInventoryItem({
    row: {
      id: row.id,
      exists: row.exists,
      language: row.language,
      pageTitle: row.pageTitle ?? null,
      url: row.url ?? null,
      foundVia: row.foundVia ?? null,
      langlinkOf: row.langlinkOf ?? null,
    },
    caseId: "c1",
    reportRunId: "r1",
  });
}

function decide(items: RawInventoryItem[]): Map<string, { decision: string; reasonCode: string }> {
  const resolution = buildSubjectResolution({
    caseId: "c1",
    datasetId: "d1",
    subject: SUBJECT,
    items,
    sourceHashes: [],
  });
  return new Map(
    resolution.items.map((i) => [i.evidenceRef, { decision: i.decision, reasonCode: i.reasonCode }])
  );
}

describe("адаптер записи проверки не чеканит подтверждённость", () => {
  it("мета «решение принято обзором» с записи снята", () => {
    const meta = checkItem({
      id: "1",
      exists: true,
      language: "ru",
      pageTitle: "Глинка (дворянский род)",
    }).rawMetadata as Record<string, unknown>;
    expect(meta.identityFromReview).toBeUndefined();
    expect(meta.skipTextClassifier).toBeUndefined();
    expect(meta.reviewStatus).toBeUndefined();
  });

  it("langlink-находка помечена своим источником", () => {
    const meta = checkItem({
      id: "2",
      exists: true,
      language: "en",
      pageTitle: "Alexei Mordashov",
      foundVia: "langlink",
      langlinkOf: { language: "ru", title: "Мордашов, Алексей Александрович" },
    }).rawMetadata as Record<string, unknown>;
    expect(meta.identityFromLanglink).toEqual({ sourceLanguage: "ru" });
  });
});

describe("принадлежность статьи решает классификатор по тексту заголовка", () => {
  it("одна фамилия в заголовке подтверждением не считается", () => {
    const item = checkItem({
      id: "1",
      exists: true,
      language: "ru",
      pageTitle: "Глинка (дворянский род)",
      url: "https://ru.wikipedia.org/wiki/Глинка_(дворянский_род)",
    });
    const decision = decide([item]).get("inventory:wiki-1")!;
    expect(decision.decision).not.toBe("SUBJECT_MATCH");
    expect(decision.reasonCode).not.toBe("compliance_match_confirmed");
  });

  it("ФИО в заголовке подтверждают принадлежность", () => {
    const item = checkItem({
      id: "1",
      exists: true,
      language: "ru",
      pageTitle: "Глинка, Михаил Иванович",
      url: "https://ru.wikipedia.org/wiki/Глинка,_Михаил_Иванович",
    });
    const decision = decide([item]).get("inventory:wiki-1")!;
    expect(decision.decision).toBe("SUBJECT_MATCH");
    expect(decision.reasonCode).toBe("full_name_match");
  });

  it("«статьи нет» остаётся тем же, чем было", () => {
    const item = checkItem({ id: "3", exists: false, language: "en" });
    const decision = decide([item]).get("inventory:wiki-3")!;
    expect(decision.decision).not.toBe("SUBJECT_MATCH");
  });
});

describe("статья межъязыковой ссылки наследует решение статьи-источника", () => {
  const ruConfirmed = checkItem({
    id: "ru",
    exists: true,
    language: "ru",
    pageTitle: "Глинка, Михаил Иванович",
    url: "https://ru.wikipedia.org/wiki/Глинка,_Михаил_Иванович",
  });
  const ruNamesake = checkItem({
    id: "ru",
    exists: true,
    language: "ru",
    pageTitle: "Глинка (дворянский род)",
    url: "https://ru.wikipedia.org/wiki/Глинка_(дворянский_род)",
  });
  // У латинского заголовка токенная классификация узнаёт только фамилию:
  // «glinka» выводится из «Глинка», а латинского написания имени у профиля без
  // транслитераций нет вовсе. Сама по себе она даёт «одну фамилию», то есть
  // «не подтверждено». Ради этого наследование и заводится.
  const enViaLanglink = checkItem({
    id: "en",
    exists: true,
    language: "en",
    pageTitle: "Mikhail Glinka",
    url: "https://en.wikipedia.org/wiki/Mikhail_Glinka",
    foundVia: "langlink",
    langlinkOf: { language: "ru", title: "Глинка, Михаил Иванович" },
  });

  it("подтверждённый источник делает подтверждённой и сестру", () => {
    const decisions = decide([ruConfirmed, enViaLanglink]);
    expect(decisions.get("inventory:wiki-ru")!.decision).toBe("SUBJECT_MATCH");
    expect(decisions.get("inventory:wiki-en")!.decision).toBe("SUBJECT_MATCH");
    expect(decisions.get("inventory:wiki-en")!.reasonCode).toBe("langlink_inherited");
  });

  it("неподтверждённый источник наследуется неподтверждённостью, а не наоборот", () => {
    const decisions = decide([ruNamesake, enViaLanglink]);
    expect(decisions.get("inventory:wiki-ru")!.decision).not.toBe("SUBJECT_MATCH");
    expect(decisions.get("inventory:wiki-en")!.decision).not.toBe("SUBJECT_MATCH");
  });

  it("без записи статьи-источника наследовать нечего", () => {
    const decisions = decide([enViaLanglink]);
    expect(decisions.get("inventory:wiki-en")!.decision).not.toBe("SUBJECT_MATCH");
    expect(decisions.get("inventory:wiki-en")!.reasonCode).not.toBe("langlink_inherited");
  });
});

/**
 * Текст статьи и способ находки лежат в снимке ответа провайдера, а страница
 * читает поля записи. Где именно они лежат, знает только писатель дополнения —
 * иначе это знание пришлось бы держать в двух местах.
 */
describe("текст статьи доезжает до артефакта дополнения", () => {
  const ROW = {
    id: "w1",
    exists: true,
    language: "en",
    pageTitle: "Alexei Mordashov",
    url: "https://en.wikipedia.org/wiki/Alexei_Mordashov",
    checkedBy: "real:WIKIPEDIA",
    snapshot: {
      source: "REAL_WIKIPEDIA",
      raw: {
        provider: "WIKIPEDIA",
        language: "en",
        query: "Mordashov Aleksey Aleksandrovich",
        articleText: "Alexei Mordashov is a Russian businessman.\n\n== Sanctions ==\nEU 2022.\n",
        foundVia: "langlink",
        langlinkOf: { language: "ru", title: "Мордашов, Алексей Александрович" },
      },
    },
  };

  it("снимок разворачивается в поля записи и попадает в бандл", async () => {
    const { bundle } = await resolveEvidenceSupplement({
      caseId: "c1",
      reportRunId: "r1",
      prisma: { wikipediaCheck: { findMany: async () => [ROW] } } as never,
    });
    const check = bundle.wikipediaChecks[0]!;
    expect(check.articleText).toContain("== Sanctions ==");
    expect(check.foundVia).toBe("langlink");
    expect(check.langlinkOf).toEqual({
      language: "ru",
      title: "Мордашов, Алексей Александрович",
    });
    expect(check.query).toBe("Mordashov Aleksey Aleksandrovich");
  });

  it("офлайн-фикстура со своими полями снимком не переписывается", async () => {
    const { bundle } = await resolveEvidenceSupplement({
      caseId: "c1",
      reportRunId: "r1",
      fixture: {
        version: "evidence-supplement-v1",
        caseId: "c1",
        wikipediaChecks: [
          {
            id: "f1",
            exists: true,
            language: "ru",
            pageTitle: "Anders Holmström",
            articleText: "Андерс Хольмстрём — предприниматель.\n\n== Биография ==\nСтокгольм.\n",
          },
        ],
        serpScreenshots: [],
      },
    });
    expect(bundle.wikipediaChecks[0]!.articleText).toContain("== Биография ==");
  });
});
