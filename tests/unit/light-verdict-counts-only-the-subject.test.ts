import { describe, expect, it } from "vitest";
import { lightVerdict, type LightVerdictInput } from "@/modules/self-check/verdict";
import { resolveItemAdverse } from "@/modules/digital-profile/orion-golden/analytics/item-adverse";
import { subjectIdentityFromProfile } from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import { ALL_ANSWERED, SCREENED, complianceItem, observation, serpItems } from "../support/light-run-fixtures";

/**
 * Лёгкий вердикт считает негатив только по материалам о субъекте.
 *
 * Первый живой прогон 23.09.2026: непубличный человек получил «критический»
 * уровень по материалам о людях с другим отчеством и по служебным страницам
 * «Внимание, розыск!», где ФИО нет вовсе, — вердикт спрашивал «негатив ли это»,
 * но не «о нём ли это». Решение владельца: в счёт идёт материал, где названы
 * фамилия и имя, а отчество, если названо, совпадает. Ответ на «о нём ли» —
 * тот же, что у отчёта: классификатор принадлежности, и в счёт — только
 * `SUBJECT_MATCH`.
 */

const SUBJECT = subjectIdentityFromProfile({
  displayName: "Иванов Иван Иванович",
  fullNameRu: { lastName: "Иванов", firstName: "Иван", patronymic: "Иванович" },
});

function input(items: RawInventoryItem[]): LightVerdictInput {
  return { items, providers: ALL_ANSWERED, screenings: SCREENED, subject: SUBJECT };
}

/**
 * Материал, который не должен идти в счёт, обязан быть негативом по нынешнему
 * правилу строки: иначе тест проверял бы словарь, а не принадлежность.
 */
function adverseItems(...titles: Array<[string, string, string?]>): RawInventoryItem[] {
  const items = serpItems(...titles.map(([title, url, snippet]) => observation(title, url, { snippet: snippet ?? "" })));
  for (const item of items) expect(resolveItemAdverse(item), item.title).toBe(true);
  return items;
}

const OTHER_PATRONYMIC = (): RawInventoryItem[] =>
  adverseItems(["Возбуждено уголовное дело против Иванова Ивана Петровича", "https://kommersant.ru/doc/7000003"]);

const SERVICE_PAGE = (): RawInventoryItem[] =>
  adverseItems([
    "Внимание, розыск!",
    "https://мвд.рф/wanted",
    "Сведения о лицах, находящихся в розыске, размещаются на сайте МВД",
  ]);

const SURNAME_ONLY = (): RawInventoryItem[] =>
  adverseItems(["Скандал вокруг Иванова: возбуждено уголовное дело", "https://ria.ru/20250313/skandal.html"]);

const FULL_NAME_OBLIQUE = (): RawInventoryItem[] =>
  adverseItems(["Возбуждено уголовное дело против Иванова Ивана Ивановича", "https://lenta.ru/news/2025/03/12/ivanov/"]);

const NAME_WITHOUT_PATRONYMIC = (): RawInventoryItem[] =>
  adverseItems(["Иван Иванов арестован по делу о мошенничестве", "https://kommersant.ru/doc/7000002"]);

describe("в счёт идёт только материал о субъекте", () => {
  it("человек с другим отчеством — не субъект", () => {
    const v = lightVerdict(input(OTHER_PATRONYMIC()));
    expect(v.verdict).toBe("CLEAN");
    expect(v.materialsFound).toBe(0);
  });

  it("служебная страница без ФИО — не материал о субъекте", () => {
    const v = lightVerdict(input(SERVICE_PAGE()));
    expect(v.verdict).toBe("CLEAN");
    expect(v.materialsFound).toBe(0);
  });

  it("одна фамилия — не субъект, даже в выдаче по его полному имени", () => {
    const v = lightVerdict(input(SURNAME_ONLY()));
    expect(v.verdict).toBe("CLEAN");
    expect(v.materialsFound).toBe(0);
  });

  it("полное ФИО в косвенном падеже — субъект", () => {
    const v = lightVerdict(input(FULL_NAME_OBLIQUE()));
    expect(v.verdict).toBe("NEGATIVE_FOUND");
    expect(v.materialsFound).toBe(1);
  });

  it("фамилия и имя без отчества — субъект", () => {
    const v = lightVerdict(input(NAME_WITHOUT_PATRONYMIC()));
    expect(v.verdict).toBe("NEGATIVE_FOUND");
    expect(v.materialsFound).toBe(1);
  });

  it("чужие материалы рядом со своими не добавляют ни счёта, ни тем", () => {
    const own = lightVerdict(input(FULL_NAME_OBLIQUE()));
    const mixed = lightVerdict(
      input([...FULL_NAME_OBLIQUE(), ...OTHER_PATRONYMIC(), ...SERVICE_PAGE(), ...SURNAME_ONLY()])
    );
    expect(mixed.materialsFound).toBe(1);
    expect(mixed.themes).toEqual(own.themes);
    expect(mixed.riskLevel).toBe(own.riskLevel);
  });
});

describe("совпадение комплаенса отсевом по тексту не судится", () => {
  it("санкционная запись базы остаётся негативом и темой, хотя её заголовок — просто имя", () => {
    const v = lightVerdict(input([...OTHER_PATRONYMIC(), complianceItem()]));
    expect(v.verdict).toBe("NEGATIVE_FOUND");
    expect(v.materialsFound).toBe(1);
    expect(v.themes.map((t) => t.id)).toEqual(["pep_rca_watchlist"]);
  });
});
