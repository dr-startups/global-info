import { describe, expect, it } from "vitest";
import {
  collectSkips,
  decideVerdict,
  parseCounters,
} from "../../scripts/run-smokes";

/**
 * Раннер смоков сам стал приёмочным контуром: если он ошибётся в исходе, весь
 * проект будет выглядеть зелёным. Поэтому его правила закреплены тестом — и
 * закреплены именно те случаи, из-за которых контур и переделывался.
 *
 * Разбор счётчиков проверяется на настоящем формате node: `tsx --test` печатает
 * TAP, и любое расхождение с ним раннер трактует как «счётчиков нет».
 */

describe("исход смока", () => {
  const ok = { tests: 7, pass: 7, fail: 0, cancelled: 0, skipped: 0 };

  it("нулевой код и пройденные проверки — успех", () => {
    expect(decideVerdict({ status: 0, counters: ok })).toEqual({ verdict: "PASS", reason: "" });
  });

  it("ненулевой код возврата — провал", () => {
    const d = decideVerdict({ status: 1, counters: ok });
    expect(d.verdict).toBe("FAIL");
    expect(d.reason).toContain("код возврата 1");
  });

  it("отменённые подтесты — провал, даже когда fail=0 и код нулевой", () => {
    // Именно этот случай маскировался: node сообщает `cancelled`, а не `fail`,
    // и по одному только `fail` смок выглядел бы исправным.
    const d = decideVerdict({
      status: 0,
      counters: { tests: 10, pass: 0, fail: 0, cancelled: 10, skipped: 0 },
    });
    expect(d.verdict).toBe("FAIL");
    expect(d.reason).toContain("отменено проверок: 10");
  });

  it("проваленные проверки — провал", () => {
    const d = decideVerdict({
      status: 0,
      counters: { tests: 7, pass: 6, fail: 1, cancelled: 0, skipped: 0 },
    });
    expect(d.verdict).toBe("FAIL");
    expect(d.reason).toContain("провалено проверок: 1");
  });

  it("прогон без единой выполненной проверки — провал, а не успех", () => {
    const d = decideVerdict({
      status: 0,
      counters: { tests: 3, pass: 0, fail: 0, cancelled: 0, skipped: 3 },
    });
    expect(d.verdict).toBe("FAIL");
    expect(d.reason).toContain("не выполнено ни одной проверки");
  });

  it("смок без TAP-счётчиков судится по коду возврата", () => {
    // Python-смоки печатают свой формат; отсутствие счётчиков не должно
    // превращаться в «ноль проверок» и валить исправный смок.
    expect(decideVerdict({ status: 0, counters: {} }).verdict).toBe("PASS");
    expect(decideVerdict({ status: 2, counters: {} }).verdict).toBe("FAIL");
  });

  it("таймаут и несостоявшийся запуск — провал", () => {
    expect(decideVerdict({ status: null, timedOut: true, counters: {} }).verdict).toBe("FAIL");
    expect(
      decideVerdict({ status: null, spawnError: "ENOENT", counters: {} }).reason
    ).toContain("ENOENT");
  });
});

describe("разбор счётчиков TAP", () => {
  it("читает итоговую сводку node", () => {
    const out = ["# tests 42", "# pass 41", "# fail 0", "# cancelled 0", "# skipped 1"].join("\n");
    expect(parseCounters(out)).toEqual({
      tests: 42,
      pass: 41,
      fail: 0,
      cancelled: 0,
      skipped: 1,
    });
  });

  it("на выводе без TAP счётчиков нет", () => {
    expect(parseCounters("smoke-x: ok audit=7 render=skipped")).toEqual({
      tests: undefined,
      pass: undefined,
      fail: undefined,
      cancelled: undefined,
      skipped: undefined,
    });
  });
});

describe("сбор пропусков", () => {
  it("берёт объявленный пропуск с причиной", () => {
    expect(collectSkips("# SKIP сверка страниц — нет артефактов")).toEqual([
      "сверка страниц — нет артефактов",
    ]);
  });

  it("понимает экранированную решётку в TAP-комментарии", () => {
    // Node прогоняет посторонний stdout теста через TAP и экранирует `#`.
    expect(collectSkips("# \\# SKIP сверка страниц — нет артефактов")).toEqual([
      "сверка страниц — нет артефактов",
    ]);
  });

  it("подхватывает штатный маркер node, когда смок ничего не объявил", () => {
    expect(collectSkips("ok 1 - сверка числа страниц # SKIP")).toEqual(["сверка числа страниц"]);
  });

  it("не считает один пропуск дважды", () => {
    const out = [
      "ok 1 - сверка числа страниц # SKIP",
      "# \\# SKIP сверка числа страниц — нет отрендеренных артефактов",
    ].join("\n");
    expect(collectSkips(out)).toEqual(["сверка числа страниц — нет отрендеренных артефактов"]);
  });

  it("на выводе без пропусков возвращает пусто", () => {
    expect(collectSkips("# tests 7\n# pass 7\nok 1 - что-то")).toEqual([]);
  });
});
