/**
 * Резюме из сюжетов — дословный эталон текста.
 *
 * Ветку сюжетов не исполняет ни один офлайн-контур: у золотого кейса чтение
 * ссылок выключено, у эталона 72 артефакта решений нет вовсе. Значит,
 * единственное, что удерживает формулировки этой ветки, — вот этот эталон:
 * слова сравниваются целиком, а не по вхождению подстроки.
 *
 * Названия сюжетов печатаются дословно строками `link-verdicts.json` — теми
 * же, что стоят на странице «о чём публикации в ТОП-20». Любая нормализация
 * (обрезка, капитализация) развела бы две страницы отчёта, и заметил бы это
 * читатель, а не тест.
 *
 * Субъект вымышленный: синтетика допустима в юните и запрещена в эталонах
 * реальных кейсов.
 */

import { describe, expect, it } from "vitest";
import { buildClientSummaryPack } from "@/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import {
  assertComposedSummaryGatesPass,
  composeClientSummary,
  themeBlockText,
} from "@/modules/digital-profile/orion-golden/analytics/client-summary-composer";
import type { CanonicalClaimsBundle } from "@/modules/digital-profile/orion-golden/contracts/canonical-claim";
import type { ClientSummaryPack } from "@/modules/digital-profile/orion-golden/contracts/client-summary-pack";
import type {
  LinkVerdict,
  VerdictThemeSummary,
} from "@/modules/digital-profile/orion-golden/contracts/link-verdict";
import type { RepresentativeEvidenceSelection } from "@/modules/digital-profile/orion-golden/contracts/representative-evidence";

const NO_CLAIMS = { claims: [] } as unknown as CanonicalClaimsBundle;
const NO_SELECTION = {
  materialThemeIds: [],
  selectedByTheme: {},
  isolatedSignificantItems: [],
  p1p2Account: [],
} as unknown as RepresentativeEvidenceSelection;

const STOCKHOLM = "Уголовное дело о налоговом мошенничестве в Стокгольме";
const MALTA = "Спор о структуре владения через мальтийский холдинг";
const NEUTRAL = "Интервью о рынке скандинавского венчурного капитала";

const STOCKHOLM_QUOTE =
  "Anders Holmström, founder of Nordkap Capital, faces tax-fraud probe in Stockholm";
const MALTA_QUOTE =
  "Мальтийский холдинг зарегистрирован на номинального владельца, следует из выписки реестра";
/** Короткая цитата: аудитор её принял, а клиенту она мысли не несёт. */
const SHORT_QUOTE = "иск подан в суде";

function verdict(over: Partial<LinkVerdict> & { evidenceRef: string }): LinkVerdict {
  return {
    schemaVersion: "link-verdict-v1",
    url: `https://affarsposten.se/${over.evidenceRef}`,
    domain: "affarsposten.se",
    subjectMatch: "subject",
    tone: "neutral",
    theme: STOCKHOLM,
    quotes: [],
    readAt: "2026-08-17T12:00:00.000Z",
    ...over,
  } as LinkVerdict;
}

const THEMES: VerdictThemeSummary[] = [
  {
    theme: STOCKHOLM,
    count: 5,
    adverseCount: 4,
    evidenceRefs: [
      "inventory:obs-01",
      "inventory:obs-02",
      "inventory:obs-03",
      "inventory:obs-04",
      "inventory:obs-05",
    ],
    examples: [],
  },
  {
    theme: MALTA,
    count: 2,
    adverseCount: 1,
    evidenceRefs: ["inventory:obs-06", "inventory:obs-07"],
    examples: [],
  },
  {
    theme: NEUTRAL,
    count: 3,
    adverseCount: 0,
    evidenceRefs: ["inventory:obs-08", "inventory:obs-09", "inventory:obs-10"],
    examples: [],
  },
];

const VERDICTS: LinkVerdict[] = [
  verdict({
    evidenceRef: "inventory:obs-01",
    rank: 1,
    tone: "adverse",
    quotes: [{ text: STOCKHOLM_QUOTE }],
  }),
  verdict({
    evidenceRef: "inventory:obs-02",
    rank: 4,
    tone: "adverse",
    domain: "pravo-obzor.ru",
    quotes: [{ text: SHORT_QUOTE }],
  }),
  verdict({
    evidenceRef: "inventory:obs-03",
    rank: 6,
    tone: "adverse",
    quotes: [{ text: SHORT_QUOTE }],
  }),
  verdict({
    evidenceRef: "inventory:obs-04",
    rank: 11,
    tone: "adverse",
    domain: "pravo-obzor.ru",
    quotes: [{ text: SHORT_QUOTE }],
  }),
  verdict({ evidenceRef: "inventory:obs-05", rank: 14 }),
  verdict({
    evidenceRef: "inventory:obs-06",
    rank: 3,
    tone: "adverse",
    theme: MALTA,
    domain: "malta-registry-watch.org",
    quotes: [{ text: MALTA_QUOTE }],
  }),
  verdict({ evidenceRef: "inventory:obs-07", rank: 8, theme: MALTA, domain: "nordic-review.se" }),
  verdict({ evidenceRef: "inventory:obs-08", rank: 2, theme: NEUTRAL, domain: "nordic-review.se" }),
  verdict({ evidenceRef: "inventory:obs-09", rank: 5, theme: NEUTRAL, domain: "nordic-review.se" }),
  verdict({ evidenceRef: "inventory:obs-10", rank: 7, theme: NEUTRAL, domain: "nordic-review.se" }),
];

function buildPack(): ClientSummaryPack {
  return buildClientSummaryPack({
    caseId: "case-holmstrom",
    datasetId: "ds-holmstrom",
    subjectId: "Anders Holmström",
    sourceHashes: ["sha256:test"],
    claimsBundle: NO_CLAIMS,
    representative: NO_SELECTION,
    overallVerdict: "HIGH",
    linkVerdicts: { themes: THEMES, verdicts: VERDICTS },
  });
}

describe("слова резюме из сюжетов", () => {
  it("итоговая оценка называет сюжеты, а не рубрики", () => {
    const pack = buildPack();
    expect(pack.overallAssessment.conclusion).toBe(
      `Итоговая оценка: высокий риск. Основные основания: ${STOCKHOLM}; ${MALTA}.`
    );
    // Основания названы один раз — самой оценкой. Числа сюжета стоят в его
    // блоке; промежуточного пересказа «Главные основания» на этом пути нет.
    expect(composeClientSummary({ pack }).sections.overallAssessment).toBe(
      `Итоговая оценка: высокий риск. Основные основания: ${STOCKHOLM}; ${MALTA}.\n` +
        "Ограничения. Вывод основан на открытых и импортированных источниках; первичные документы могут изменить оценку. " +
        "Медийные утверждения не приравниваются к установленным фактам."
    );
  });

  it("блок сюжета печатается целиком и дословно", () => {
    const summary = composeClientSummary({ pack: buildPack() });
    assertComposedSummaryGatesPass(summary);
    const stockholm = summary.sections.themes[0]!;
    expect(stockholm.heading).toBe(STOCKHOLM);
    expect(themeBlockText(stockholm.heading, stockholm.body)).toBe(
      `${STOCKHOLM}. По сюжету прочитано 5 публикаций, 4 из них нежелательные. ` +
        "Источники: affarsposten.se, pravo-obzor.ru. " +
        `«${STOCKHOLM_QUOTE}» — источник affarsposten.se. ` +
        "Сведения требуют проверки по первичным документам; наличие публикации не подтверждает изложенные обвинения."
    );
    const malta = summary.sections.themes[1]!;
    // Оговорка не повторяется: её уже прочитали в предыдущем блоке.
    expect(themeBlockText(malta.heading, malta.body)).toBe(
      `${MALTA}. По сюжету прочитано 2 публикации, 1 из них нежелательная. ` +
        "Источники: malta-registry-watch.org, nordic-review.se. " +
        `«${MALTA_QUOTE}» — источник malta-registry-watch.org.`
    );
  });

  it("нейтральный сюжет в резюме не печатается", () => {
    const summary = composeClientSummary({ pack: buildPack() });
    expect(summary.sections.themes.map((t) => t.heading)).toEqual([STOCKHOLM, MALTA]);
    expect(summary.fullText).not.toContain(NEUTRAL);
  });

  it("следующие проверки называют сюжеты одной строкой", () => {
    const summary = composeClientSummary({ pack: buildPack() });
    expect(summary.sections.nextSteps).toBe(
      `Следующие проверки. 1) Сверить первоисточники и статус материалов по теме «${STOCKHOLM}», «${MALTA}». ` +
        "2) Сверить актуальность санкционных и мониторинговых записей по официальным источникам. " +
        "3) Подготовить единый пакет документов для KYC и партнёрских запросов."
    );
  });

  it("трафарета «Установлено:» нет ни в пакете, ни в резюме", () => {
    const pack = buildPack();
    expect(JSON.stringify(pack)).not.toContain("Установлено:");
    expect(composeClientSummary({ pack }).fullText).not.toContain("Установлено:");
  });

  it("два прогона дают одни и те же слова", () => {
    expect(buildPack()).toEqual(buildPack());
    const pack = buildPack();
    expect(composeClientSummary({ pack })).toEqual(composeClientSummary({ pack }));
  });
});
