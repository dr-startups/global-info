import { describe, expect, it } from "vitest";
import { caseListWhere } from "../../src/modules/digital-profile/services/case-service";

/**
 * Шаг 13, этап 5 (docs/rework/13-regression-run-findings.md, B6).
 *
 * В списке кейсов оператора лежали двадцать заглушек `SMOKE-*`, оставленных
 * смоками. Список принадлежит оператору: следы прогонов смоков — не его работа.
 */

describe("что попадает в список кейсов", () => {
  it("фикстуры смоков в список не входят", () => {
    expect(caseListWhere({})).toMatchObject({ isFixture: false });
  });

  it("удалённые по-прежнему скрыты по умолчанию", () => {
    expect(caseListWhere({})).toMatchObject({ deletedAt: null, isFixture: false });
  });

  it("явный запрос фикстур снимает фильтр, но не открывает удалённые", () => {
    const where = caseListWhere({}, { includeFixtures: true });
    expect(where).not.toHaveProperty("isFixture");
    expect(where).toMatchObject({ deletedAt: null });
  });

  it("includeDeleted снимает только фильтр удаления", () => {
    // Две разные вещи скрывают кейс по разным причинам, и снятие одного
    // фильтра не должно тянуть за собой другой.
    const where = caseListWhere({ includeDeleted: true });
    expect(where).not.toHaveProperty("deletedAt");
    expect(where).toMatchObject({ isFixture: false });
  });

  it("ограничение по доступу и фильтр фикстур действуют вместе", () => {
    // CLIENT_VIEWER видит только выданные кейсы — фикстура среди них тоже
    // остаётся скрытой.
    const where = caseListWhere({}, { restrictToCaseIds: ["case-1", "case-2"] });
    expect(where).toMatchObject({
      isFixture: false,
      id: { in: ["case-1", "case-2"] },
    });
  });

  it("поиск ищет по названию, номеру и имени субъекта", () => {
    const where = caseListWhere({ q: "дуров" });
    expect(where.OR).toHaveLength(3);
    expect(where).toMatchObject({ isFixture: false });
  });

  it("фильтр по статусу сохраняется", () => {
    expect(caseListWhere({ status: "COLLECTING" })).toMatchObject({
      status: "COLLECTING",
      isFixture: false,
    });
  });
});
