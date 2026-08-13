import { describe, expect, it } from "vitest";
import { resolveSerpProviderAttribution } from "@/modules/digital-profile/services/unified-base-report-run";

describe("resolveSerpProviderAttribution", () => {
  it("верит полю строки, а не подсказке прогона", () => {
    // Живой дефект: манифест прогона перечислял yandex первым, и его подсказка
    // подставлялась КАЖДОЙ строке. 216 строк Google получили ярлык «Яндекс»
    // при собственном engine=GOOGLE, а отчёт сообщил, что Google не собрался.
    const attr = resolveSerpProviderAttribution({
      manifestProviderHint: "yandex",
      engine: "GOOGLE",
      source: "real:GOOGLE",
    });
    expect(attr.engineLabel).toBe("GOOGLE");
    expect(attr.provider).toBe("serper");
  });

  it("не теряет Яндекс, когда строка яндексовая", () => {
    const attr = resolveSerpProviderAttribution({
      manifestProviderHint: "google",
      engine: "YANDEX",
      source: "real:YANDEX",
    });
    expect(attr.engineLabel).toBe("YANDEX");
  });

  it("сохранённый provider наблюдения сильнее всего остального", () => {
    const attr = resolveSerpProviderAttribution({
      observationProvider: "yandex",
      engine: "GOOGLE",
      manifestProviderHint: "google",
    });
    expect(attr.engineLabel).toBe("YANDEX");
  });

  it("подсказка манифеста работает, когда про строку не известно ничего", () => {
    const attr = resolveSerpProviderAttribution({ manifestProviderHint: "yandex" });
    expect(attr.engineLabel).toBe("YANDEX");
  });

  it("без единого сигнала не выдумывает поисковик", () => {
    const attr = resolveSerpProviderAttribution({});
    expect(attr.engineLabel).toBe("UNKNOWN");
    expect(attr.provider).toBe("base");
  });

  it("расхождение сигналов записывается в диагностику", () => {
    const attr = resolveSerpProviderAttribution({
      engine: "GOOGLE",
      manifestProviderHint: "yandex",
    });
    expect(attr.conflictDiagnostic).toContain("provider_conflict");
    expect(attr.conflictDiagnostic).toContain("base_manifest_provider");
  });

  it("engine запроса уступает полю самой строки", () => {
    const attr = resolveSerpProviderAttribution({
      queryEngine: "YANDEX",
      engine: "GOOGLE",
    });
    expect(attr.engineLabel).toBe("GOOGLE");
  });
});
