/**
 * Слайд-продолжение не выводит текст из-под ворот области.
 *
 * Ворота «домен выведен из доказательств страницы» — fail-closed: домен,
 * которого нет среди доказательств слайда, роняет обязательную секцию, то есть
 * всю деку. Ворота ходили по списку шаблонов и по трём полям сайдбара, поэтому
 * новый тип страницы («…: почему выделено», текст в `bullets`) оказался вне
 * проверки — а это самый насыщенный доменами лист отчёта: цитаты и адреса
 * первоисточников.
 *
 * Второе: напечатанный адрес освобождён от разбора целиком, и через соседство
 * с ним в текст проходил чужой домен — «a.ru/x,b.ru» разбиралось как один
 * адрес.
 */

import { describe, expect, it } from "vitest";
import {
  loadReport72DeckInputs,
  loadReportAssets,
} from "../../scripts/run-orion-deck-sections-report72";
import { buildSectionPackForFragment } from "@/modules/digital-profile/orion-golden/deck-sections/section-builders";
import type { SectionBuildContext } from "@/modules/digital-profile/orion-golden/deck-sections/section-builders";
import {
  undeclaredClientTextDomains,
  validateSectionPack,
} from "@/modules/digital-profile/orion-golden/deck-sections/section-validation";
import type { ExecutiveSummaryExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type {
  VisibleAssetItem,
  VisualAssetsBySlot,
} from "@/modules/digital-profile/orion-golden/deck-sections/canonical-slots";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const inputs = loadReport72DeckInputs();
const fixture = loadReportAssets(inputs.evidenceIndex).visualAssets;
const ruRows: VisibleAssetItem[] = (fixture.p10_ru_serp_visual ?? []).flatMap(
  (a) => a.visibleItems ?? []
);
const xRow = ruRows.find((r) => r.domain === "x.com")!;
const rupepRow = ruRows.find((r) => r.domain === "rupep.org")!;

const FOREIGN = "evil-competitor-domain.ru";

/** Цитата со страницы, называющая чужой домен: она попадёт во фразу дословно. */
const QUOTE_WITH_FOREIGN_DOMAIN =
  `В материале приведена ссылка на первоисточник ${FOREIGN}, где опубликован ` +
  "тот же перечень эпизодов и приложены копии документов по каждому из них.";

function snapshotMeta(rows: VisibleAssetItem[]): VisualAssetsBySlot {
  return {
    p10_ru_serp_visual: [
      {
        assetRef: "ru_serp_snapshot",
        kind: "serp_screenshot",
        title: "Россия — результаты поисковой выдачи",
        hasImage: true,
        evidenceRefs: rows.map((r) => r.ref),
        evidenceDomains: [...new Set(rows.map((r) => r.domain).filter(Boolean))] as string[],
        visibleItems: rows,
      },
    ],
  };
}

function pack(rows: VisibleAssetItem[], evidenceIndex: ScopedEvidenceIndex) {
  const ctx: SectionBuildContext = {
    caseId: inputs.caseId,
    reportRunId: inputs.reportRunId,
    sourceDatasetId: inputs.sourceDatasetId,
    contentVersion: "test-content-version",
    subject: { displayName: "Сергей Глинка", aliases: ["Sergey Glinka"] },
    bundle: inputs.mergedBundle,
    surfaceUnits: inputs.surfaceUnits,
    metricSnapshot: inputs.metricSnapshot,
    evidenceIndex,
    extras: {
      executiveSummary: inputs.executiveSummary as unknown as ExecutiveSummaryExtras,
      surfaceCollectionHints: inputs.surfaceCollectionHints,
      visualAssets: snapshotMeta(rows),
    },
    buildLog: [],
  };
  return buildSectionPackForFragment("RU_SERP_SCREENSHOT", ctx);
}

describe("чужой домен не проезжает на слайде-продолжении", () => {
  const evidence = {
    ...inputs.evidenceIndex,
    [rupepRow.ref]: {
      ...inputs.evidenceIndex[rupepRow.ref],
      verdictTheme: "Судебные эпизоды и арест активов",
      readVerdictTone: "adverse",
      pageQuote: QUOTE_WITH_FOREIGN_DOMAIN,
    },
  } as ScopedEvidenceIndex;

  const built = pack(
    [
      { ...xRow, adverse: true },
      { ...rupepRow, adverse: true },
      ...ruRows.slice(4, 7),
    ],
    evidence
  );

  it("продолжение с чужим доменом в буллете валидацию не проходит", () => {
    const cont = built.slides.filter((s) => s.isContinuation);
    expect(cont.length).toBeGreaterThan(0);
    expect((cont[0]!.content.bullets ?? []).join(" ")).toContain(FOREIGN);

    const report = validateSectionPack({
      pack: built,
      expectedCaseId: inputs.caseId,
      expectedReportRunId: inputs.reportRunId,
      expectedDatasetId: inputs.sourceDatasetId,
      bundle: inputs.mergedBundle,
      knownEvidenceRefs: new Set(Object.keys(inputs.evidenceIndex)),
      evidenceIndex: evidence,
    });
    expect(report.passed).toBe(false);
    expect(report.issues.join(" | ")).toContain(FOREIGN);
    expect(report.issues.join(" | ")).toContain(cont[0]!.slideId);
  });
});

describe("разбор доменов клиентского текста", () => {
  const allowed = new Set(["a.ru", "x.com"]);

  it("домен через запятую после адреса не теряется", () => {
    expect(undeclaredClientTextDomains("Текст a.ru/x,b.ru.", allowed)).toEqual(["b.ru"]);
  });

  it("домен через пробел после адреса ловится по-прежнему", () => {
    expect(undeclaredClientTextDomains("Текст a.ru/x b.ru.", allowed)).toEqual(["b.ru"]);
  });

  it("чужой домен внутри пути непроверяемого адреса не освобождается", () => {
    expect(undeclaredClientTextDomains("Текст a.ru/x/evil.com.", allowed)).toEqual(["evil.com"]);
  });

  it("адрес из доказательств страницы освобождён целиком, включая путь", () => {
    const links = new Set(["a.ru/otchet/2024/itog.html"]);
    expect(
      undeclaredClientTextDomains("Текст a.ru/otchet/2024/itog.html.", allowed, links)
    ).toEqual([]);
  });
});

describe("свой адрес освобождён целиком, каким бы он ни был", () => {
  /*
   * Путь адреса не имеет «конца слова»: в нём законны пробел (из `%20`), точка
   * с запятой, апостроф, скобки. Любой набор терминаторов на них промахивается,
   * матч обрывается, освобождение не срабатывает — и хвост СВОЕГО адреса уходит
   * в общий разбор, где `otchet.html` выглядит доменом. Это ровно тот боевой
   * отказ обязательной секции, ради которого освобождение и заводилось.
   */
  const own = [
    "en.wikipedia.org/wiki/Sergey_Glinka_(businessman)",
    "ria.ru/20240101/otchet-o-proverke,-itogi.html",
    "rupep.org/ru/person/Иван Иванов/otchet.html",
    "vc.ru/legal/12345-delo-o-bankrotstve;-etap-2/doc.pdf",
    "example-real.ru/a'b/otchet.html",
  ];
  const hosts = new Set([
    "en.wikipedia.org",
    "ria.ru",
    "rupep.org",
    "vc.ru",
    "example-real.ru",
  ]);

  for (const link of own) {
    it(`адрес страницы не порождает находок: ${link}`, () => {
      expect(
        undeclaredClientTextDomains(`На странице — сюжет: «цитата». ${link}.`, hosts, new Set([link]))
      ).toEqual([]);
    });
  }

  it("чужой адрес того же вида по-прежнему отвечает и за хост, и за путь", () => {
    expect(
      undeclaredClientTextDomains(
        "Текст chuzhoy.ru/a'b/otchet.html.",
        hosts,
        new Set(own)
      ).sort()
    ).toEqual(["chuzhoy.ru", "otchet.html"]);
  });
});

describe("вырезается адрес страницы, а не всякая строка, где он встретился", () => {
  /*
   * Освобождение ищет печатный адрес в тексте. Если у страницы есть
   * доказательство с корневым адресом, печатная форма — голый домен («x.com»),
   * и вырезание сырой подстрокой снимало его изнутри чужих имён: `evil-x.com`,
   * `mx.com`, `yx.com` уходили из разбора вместе с ним. Результат выдачи,
   * ведущий на главную страницу источника, — вещь совершенно обычная, а чем
   * короче собственный домен, тем шире захват.
   */
  const hosts = new Set(["x.com"]);
  const rootLink = new Set(["x.com"]);

  it("чужой домен, кончающийся своим, ловится", () => {
    expect(undeclaredClientTextDomains("Материал взят с evil-x.com.", hosts, rootLink)).toEqual([
      "evil-x.com",
    ]);
  });

  it("чужой домен, начинающийся с буквы перед своим, ловится", () => {
    expect(undeclaredClientTextDomains("Ссылка на mx.com в тексте.", hosts, rootLink)).toEqual([
      "mx.com",
    ]);
  });

  it("чужой домен с путём, кончающийся своим, ловится", () => {
    expect(
      undeclaredClientTextDomains("Ссылка на evil-x.com/page в тексте.", hosts, rootLink)
    ).toEqual(["evil-x.com"]);
  });

  it("соседний домен ловится", () => {
    expect(undeclaredClientTextDomains("Соседний домен yx.com.", hosts, rootLink)).toEqual([
      "yx.com",
    ]);
  });

  it("чужой адрес, внутри которого встретился свой, ловится", () => {
    const issues = undeclaredClientTextDomains(
      "Текст zz-a.ru/x-evil.com",
      new Set(["a.ru"]),
      new Set(["a.ru/x"])
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues).toContain("zz-a.ru");
  });

  it("свой корневой адрес по-прежнему освобождается", () => {
    expect(undeclaredClientTextDomains("Источник — x.com.", hosts, rootLink)).toEqual([]);
  });
});
