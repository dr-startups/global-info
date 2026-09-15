import { afterEach, describe, expect, it, vi } from "vitest";
import { SITE_GOALS, metrikaInitOptions, setMetrikaCounter, track } from "@/modules/site/analytics";

/**
 * Цели Метрики уходят через один `track()`. Счётчика может не быть (стенд,
 * пустая настройка) или его скрипт заблокирован расширением — проверка при этом
 * обязана пройти: аналитика не ломает путь посетителя ни отказом, ни исключением.
 */

type Ym = (...args: unknown[]) => void;
const globalWithYm = globalThis as typeof globalThis & { ym?: Ym };

afterEach(() => {
  setMetrikaCounter(null);
  delete globalWithYm.ym;
});

describe("track()", () => {
  it("цели — те, что названы в ТЗ 3.11", () => {
    expect([...SITE_GOALS]).toEqual([
      "form_start",
      "form_submit",
      "persona_shown",
      "persona_decided",
      "run_started",
      "verdict_shown",
      "lead_sent",
    ]);
  });

  it("без счётчика молчит, даже если скрипт Метрики на странице есть", () => {
    const ym = vi.fn();
    globalWithYm.ym = ym;
    expect(() => track("form_start")).not.toThrow();
    expect(ym).not.toHaveBeenCalled();
  });

  it("со счётчиком — reachGoal с параметрами", () => {
    const ym = vi.fn();
    globalWithYm.ym = ym;
    setMetrikaCounter("12345678");
    track("verdict_shown", { verdict: "CLEAN" });
    expect(ym).toHaveBeenCalledWith(12345678, "reachGoal", "verdict_shown", { verdict: "CLEAN" });
  });

  it("счётчик задан, а скрипт заблокирован или упал — путь посетителя не ломается", () => {
    setMetrikaCounter("12345678");
    expect(() => track("lead_sent")).not.toThrow();
    globalWithYm.ym = () => {
      throw new Error("blocked");
    };
    expect(() => track("lead_sent")).not.toThrow();
  });

  it("вебвизор выключен: на страницах формы с ФИО и датой рождения", () => {
    expect(metrikaInitOptions().webvisor).toBe(false);
  });
});
