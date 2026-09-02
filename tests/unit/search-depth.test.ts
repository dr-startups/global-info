import { describe, expect, it } from "vitest";
import { resolveSearchDepth } from "@/modules/digital-profile/providers/search-depth";

describe("resolveSearchDepth", () => {
  it("отдаёт запрошенную глубину, даже когда она больше настройки по умолчанию", () => {
    // Тот самый дефект: аудит просил 20, настройка стояла 10, провайдер отдавал
    // 10 и возвращал SUCCESS. Отчёт называл первую страницу «ТОП-20».
    expect(resolveSearchDepth({ requested: 20, fallback: 10, max: 50 })).toBe(20);
  });

  it("берёт настройку, когда глубину не просили", () => {
    expect(resolveSearchDepth({ fallback: 10, max: 50 })).toBe(10);
  });

  it("не пускает глубже предела API", () => {
    expect(resolveSearchDepth({ requested: 500, fallback: 10, max: 50 })).toBe(50);
  });

  it("игнорирует бессмысленную просьбу и возвращается к настройке", () => {
    expect(resolveSearchDepth({ requested: 0, fallback: 10, max: 50 })).toBe(10);
    expect(resolveSearchDepth({ requested: -3, fallback: 10, max: 50 })).toBe(10);
    expect(resolveSearchDepth({ requested: Number.NaN, fallback: 10, max: 50 })).toBe(10);
  });

  it("всегда отдаёт хотя бы один результат", () => {
    expect(resolveSearchDepth({ requested: 20, fallback: 10, max: 0 })).toBe(1);
  });

  it("округляет дробную глубину вниз", () => {
    expect(resolveSearchDepth({ requested: 20.9, fallback: 10, max: 50 })).toBe(20);
  });
});
