import { describe, expect, it } from "vitest";
import {
  getAdversePatterns,
  getFindingThemes,
} from "@/modules/digital-profile/config/finding-themes";
import { synthesizeFindings } from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import type { SubjectResolutionItem } from "@/modules/digital-profile/orion-golden/contracts/subject-resolution";

function theme(themeId: string) {
  const t = getFindingThemes().find((x) => x.themeId === themeId);
  if (!t) throw new Error(`нет темы ${themeId}`);
  return t.keywords;
}

describe("слово темы совпадает с началом слова", () => {
  /**
   * Разбор живого прогона: по криминальной теме набралось 27 материалов, и
   * среди них не было ни одного судебного сюжета — «суд» находился внутри
   * «го-суд-арственной». Так под тему «Криминальные / судебные материалы»
   * попали «Структура | Совет Федерации» и «20 самых богатых людей России».
   */
  it("«государственной» не делает материал судебным", () => {
    const crim = theme("criminal_legal");
    expect(crim.test("представитель органа государственной власти Республики Дагестан")).toBe(
      false
    );
    expect(crim.test("стал депутатом Государственной думы")).toBe(false);
  });

  it("настоящие судебные и криминальные слова остаются", () => {
    const crim = theme("criminal_legal");
    expect(crim.test("суд Франции освободил его под подписку")).toBe(true);
    expect(crim.test("возбуждено уголовное дело")).toBe(true);
    expect(crim.test("служба судебных приставов")).toBe(true);
    expect(crim.test("прокуратура Ниццы начала расследование")).toBe(true);
  });

  it("«судьба» судом не является", () => {
    const crim = theme("criminal_legal");
    expect(crim.test("непростая судьба предпринимателя")).toBe(false);
    expect(crim.test("Судьбоносным это время стало и для него")).toBe(false);
  });

  it("«администрация» не делает материал политическим, а «министр» делает", () => {
    const pol = theme("political_exposure");
    expect(pol.test("администрация подписала распоряжение")).toBe(false);
    expect(pol.test("министр финансов выступил")).toBe(true);
  });

  it("«долгое время» не является долговым спором", () => {
    const fin = theme("financial_claims");
    expect(fin.test("личная жизнь долгое время обсуждалась")).toBe(false);
    expect(fin.test("суд постановил взыскать долги")).toBe(true);
    expect(fin.test("задолженность перед банком")).toBe(true);
  });
});

describe("признак негативного материала", () => {
  it("не срабатывает на «судьбе»", () => {
    expect(getAdversePatterns().test("непростая судьба предпринимателя")).toBe(false);
  });

  it("срабатывает на суде и санкциях", () => {
    expect(getAdversePatterns().test("суд признал требования обоснованными")).toBe(true);
    expect(getAdversePatterns().test("введены санкции")).toBe(true);
  });
});

/**
 * Корень задан списком исключений — и список приходится дополнять на каждой
 * находке. `суд(?!острое|ьб)` закрывал ровно два слова семейства; замер по
 * словам показал, что «судмедэксперт», «судоходство» и «судоверфь» проходили
 * обе проверки. «Судмедэксперт дал заключение» получало метку негатива и
 * криминальную тему на нейтральном материале — а отчёт читает сам субъект,
 * которому предлагают убирать то, что его не порочит.
 *
 * Проверка ходит по обоим местам сразу: корень стоит и в словах темы
 * `criminal_legal`, и в словаре негатива, и починка одного оставила бы дефект
 * в другом — на той же странице, у того же читателя.
 */
describe("корень «суд» означает суд, а не всё, что на «суд» начинается", () => {
  function marks(text: string): { тема: boolean; негатив: boolean } {
    return {
      тема: theme("criminal_legal").test(text),
      негатив: getAdversePatterns().test(text),
    };
  }

  const НЕТ = { тема: false, негатив: false };
  const ДА = { тема: true, негатив: true };

  it("судебное семейство слов метку и тему получает", () => {
    expect(marks("суд отказал в иске")).toEqual(ДА);
    expect(marks("судебный процесс назначен на май")).toEqual(ДА);
    expect(marks("возбуждено уголовное дело")).toEqual(ДА);
    expect(marks("арест имущества по требованию кредитора")).toEqual(ДА);
  });

  it("падежи самого слова «суд» остаются на месте", () => {
    expect(marks("суд")).toEqual(ДА);
    expect(marks("решение суда вступило в силу")).toEqual(ДА);
    expect(marks("дело рассмотрено в суде")).toEqual(ДА);
    expect(marks("требование удовлетворено судом")).toEqual(ДА);
    expect(marks("обратился к суду с ходатайством")).toEqual(ДА);
    expect(marks("по картотекам судов")).toEqual(ДА);
    expect(marks("иски поданы в суды двух инстанций")).toEqual(ДА);
    expect(marks("документы направлены судам и приставам")).toEqual(ДА);
    expect(marks("спор рассматривается судами обеих сторон")).toEqual(ДА);
    expect(marks("дело в судах первой инстанции")).toEqual(ДА);
  });

  it("судья, судимость и судопроизводство остаются", () => {
    expect(marks("судья вынес решение")).toEqual(ДА);
    expect(marks("ходатайство передано судье")).toEqual(ДА);
    expect(marks("коллегия судей вынесла решение")).toEqual(ДА);
    expect(marks("ранее судимый за мошенничество")).toEqual(ДА);
    expect(marks("непогашенная судимость")).toEqual(ДА);
    expect(marks("судопроизводство переведено в электронный вид")).toEqual(ДА);
    expect(marks("компания судится с подрядчиком")).toEqual(ДА);
    expect(marks("стороны судятся уже второй год")).toEqual(ДА);
  });

  it("судмедэксперт, судоходство и судоверфь метки не получают", () => {
    expect(marks("Судмедэксперт дал заключение о причине смерти")).toEqual(НЕТ);
    expect(marks("исследование посвящено судоходству в Арктике")).toEqual(НЕТ);
    expect(marks("судоверфь спустила на воду танкер")).toEqual(НЕТ);
  });

  /**
   * Слова, которых нет ни в одном перечне: если бы корень чинили новым
   * исключением, каждое из них пришлось бы вписать поимённо. Форма обязана
   * закрывать их, не зная о них.
   */
  it("прочие «суд»-слова, которых никто не перечислял, тоже не совпадают", () => {
    expect(marks("грузовое судно вышло из порта")).toEqual(НЕТ);
    expect(marks("судовладелец зарегистрирован на Кипре")).toEqual(НЕТ);
    expect(marks("судоремонтный завод получил заказ")).toEqual(НЕТ);
    expect(marks("на ужин подали судака")).toEqual(НЕТ);
    expect(marks("судорога свела ногу на тренировке")).toEqual(НЕТ);
    expect(marks("сударь, позвольте пройти")).toEqual(НЕТ);
    // «Судейство» и «судейский» — чаще ринг, чем коллегия, и правая граница
    // разводит их с «судей» без нового исключения.
    expect(marks("судейство на ринге вызвало вопросы")).toEqual(НЕТ);
  });

  it("и они не перечислены поимённо — иначе список исключений просто вырос", () => {
    for (const source of [theme("criminal_legal").source, getAdversePatterns().source]) {
      expect(source).not.toContain("судмед");
      expect(source).not.toContain("судоход");
      expect(source).not.toContain("судоверф");
      expect(source).not.toContain("судно");
      expect(source).not.toContain("судак");
    }
  });

  it("судостроение, судьба и правосудие по-прежнему не совпадают", () => {
    expect(marks("государственное судостроение и морские перевозки")).toEqual(НЕТ);
    expect(marks("непростая судьба предпринимателя")).toEqual(НЕТ);
    expect(marks("правосудие должно быть скорым")).toEqual(НЕТ);
    expect(marks("представитель органа государственной власти")).toEqual(НЕТ);
  });

  /**
   * Ошибка симметрична: ложная метка на благоприятном материале вредит
   * клиенту так же, как пропущенный негатив.
   */
  it("благоприятный материал метки не получает ни до, ни после сужения", () => {
    expect(marks("Биография предпринимателя и его путь к успеху")).toEqual(НЕТ);
    expect(marks("интервью о развитии логистики")).toEqual(НЕТ);
  });

  /**
   * Цена левой границы, а не корня: «подсудимый» и «осуждён» не совпадают и
   * до сужения — граница слова ставится просмотром назад по букве, и корень
   * внутри слова не виден. Убрать её нельзя: без неё «государственной»
   * снова делает биографию криминальным материалом. Сужение корня этого не
   * меняет, и проверка стоит здесь, чтобы следующий читатель не «починил»
   * одно, сломав другое.
   */
  it("«подсудимый» и «осуждён» не совпадают — так решает левая граница", () => {
    expect(marks("подсудимый дал показания")).toEqual(НЕТ);
    expect(marks("осуждён на три года")).toEqual(НЕТ);
  });
});

/**
 * Сокращение — не основа: у него правая граница обязательна.
 *
 * «ФСБР» — Федерация спортивной борьбы России, и два отчёта подряд она
 * печаталась клиенту «Вниманием по линии безопасности / оборонным контуром»
 * высокого уровня. Слово стоит в двух словарях сразу (тема и метка негатива),
 * поэтому проверка ходит по обоим: починка одного оставила бы ложную метку на
 * той же странице у того же читателя.
 */
describe("сокращение читается сокращением, а не основой", () => {
  function marks(text: string): { тема: boolean; негатив: boolean } {
    return {
      тема: theme("security_scrutiny").test(text),
      негатив: getAdversePatterns().test(text),
    };
  }

  const НЕТ = { тема: false, негатив: false };
  const ДА = { тема: true, негатив: true };

  it("«ФСБР» — федерация спортивной борьбы, а не оборонный контур", () => {
    expect(
      marks(
        "После назначения главой Наблюдательного совета ФСБР Умар Назарович Кремлев предложил уделить внимание системе поощрения спортсменов"
      )
    ).toEqual(НЕТ);
    expect(marks("Умар Кремлёв был избран на высокий пост в ФСБР")).toEqual(НЕТ);
    expect(marks("Federation FSBR announced the new board")).toEqual(НЕТ);
  });

  it("настоящее «ФСБ» тему и метку сохраняет", () => {
    expect(marks("Могущественный генерал ФСБ помогает «серпуховскому хану»")).toEqual(ДА);
    expect(marks("The FSB general commented on the case")).toEqual(ДА);
  });

  /**
   * Граница латинского сокращения написана просмотром по букве, а не `\b`: в
   * JavaScript граница слова определена на ASCII, и в «FSBа» с кириллической
   * «а» она срабатывает — совпадение прошло бы. То же уже написано в файле про
   * `pep`, и терять это при правке нельзя.
   */
  it("латинская запись закрыта просмотром по букве, а не границей слова", () => {
    expect(marks("Генерал FSBа отказался от комментариев")).toEqual(НЕТ);
  });
});

/**
 * Материал, потерявший единственную тему, из отчёта не исчезает: он доезжает до
 * блока неотнесённых с заголовком и доменом. Иначе починка ложной темы
 * оборачивалась бы молчаливой пропажей материала из всех артефактов сразу.
 */
describe("материал без темы доезжает до неотнесённых", () => {
  const CASE_ID = "case-unit-abbreviation";

  function fsbrItem(): RawInventoryItem {
    return {
      inventoryId: "it-fsbr-1",
      caseId: CASE_ID,
      reportRunId: "run-1",
      source: "serp_observation",
      provider: "yandex",
      region: "RU",
      collectedAt: "2026-08-31T00:00:00.000Z",
      evidenceType: "search_result",
      title: "Главой Наблюдательного совета ФСБР избран Умар Кремлев",
      snippet: "",
      sourceUrl: "https://irk.ru/news/articles/20260731/struggle",
      rawMetadata: { surface: "organic", engine: "YANDEX" },
    };
  }

  it("ФСБР остаётся в отчёте — без темы, но с заголовком и доменом", () => {
    const item = fsbrItem();
    const ref = `inventory:${item.inventoryId}`;
    const result = synthesizeFindings({
      caseId: CASE_ID,
      datasetId: "ds-abbreviation",
      items: [item],
      resolutionByRef: new Map([
        [ref, { evidenceRef: ref, decision: "SUBJECT_MATCH" } as SubjectResolutionItem],
      ]),
      sourceHashes: ["sha256:test"],
    });

    expect(result.themeAssignments.get(ref) ?? []).toEqual([]);
    expect(result.bundle.findings).toEqual([]);
    expect(result.uncategorized.allEvidenceRefs).toEqual([ref]);
    expect(result.uncategorized.topExamples[0]?.title).toContain("ФСБР");
    expect(result.uncategorized.topExamples[0]?.domain).toBe("irk.ru");
  });
});
