/**
 * Судья потерь рендерера на живом пути.
 *
 * Вопрос «потерял ли рендерер содержимое» уже имеет ответ —
 * `classifyLayoutTelemetryRows`, тот же классификатор, которым пользуется
 * TS-инспектор геометрии. Ворота живого пути не заводят второго разбора: они
 * читают файл и решают, что делать с выдачей классификатора. Здесь пинается
 * именно это решение:
 *
 *   · потеря целых блоков — блокер (отчёт не выдаётся);
 *   · клип — громкое предупреждение, но не блок: `clipped` на текстовом пути
 *     это предсказание меры высоты, а мера завышает — блокировка по ней
 *     останавливала бы здоровые прогоны;
 *   · нечитаемая телеметрия и пустой список записей после настоящего рендера —
 *     отказ, а не пропуск: классификатор на таком входе отдаёт пустой список,
 *     неотличимый от «проверено, потерь нет».
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeRenderTelemetry } from "@/modules/digital-profile/services/render-telemetry-gate";

function renderDirWith(content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "render-telemetry-gate-"));
  if (content !== null) {
    writeFileSync(join(dir, "layout-telemetry.json"), content, "utf8");
  }
  return dir;
}

function telemetryDir(entries: Array<Record<string, unknown>>): string {
  return renderDirWith(
    JSON.stringify({ version: "orion-layout-telemetry-v1", entries }, null, 2)
  );
}

const CLEAN_ENTRY = {
  page: 3,
  name: "orion_text_body_p3",
  role: "text",
  requiredHeight: 197_815,
  availableHeight: 1_100_000,
  clipped: false,
  measurementUncertain: false,
};

describe("живые ворота потерь рендерера", () => {
  it("потеря целых блоков блокирует выдачу и называет страницу", () => {
    const verdict = judgeRenderTelemetry(
      telemetryDir([
        CLEAN_ENTRY,
        {
          page: 6,
          name: "orion_risk_matrix_cards_p6",
          role: "cards",
          droppedBullets: 1,
          droppedLines: 0,
          clipped: false,
          requiredHeight: 5_500_000,
          availableHeight: 5_025_200,
        },
      ])
    );
    expect(verdict.blocker).toBe("CONTENT_DROPPED_BY_RENDERER");
    expect(verdict.detail).toContain("6");
    expect(verdict.detail).toContain("layout-telemetry.json");
  });

  it("чистая телеметрия проходит без блокера и без предупреждений", () => {
    const verdict = judgeRenderTelemetry(telemetryDir([CLEAN_ENTRY]));
    expect(verdict.blocker).toBeNull();
    expect(verdict.warnings).toEqual([]);
  });

  it("клип не блокирует, но слышен стабильным токеном без дублей", () => {
    const clip = {
      page: 7,
      name: "orion_text_body_p7",
      role: "text",
      clipped: true,
      requiredHeight: 1_400_000,
      availableHeight: 1_100_000,
    };
    const verdict = judgeRenderTelemetry(telemetryDir([clip, { ...clip }, CLEAN_ENTRY]));
    expect(verdict.blocker).toBeNull();
    expect(verdict.warnings).toEqual(["renderer-clip:page=7:text-clipping"]);
  });

  it("отсутствие файла — отказ, а не пропуск", () => {
    const verdict = judgeRenderTelemetry(renderDirWith(null));
    expect(verdict.blocker).toBe("RENDER_TELEMETRY_MISSING");
    expect(verdict.detail).toMatch(/непровер/i);
  });

  it("битый файл телеметрии — тот же отказ", () => {
    const verdict = judgeRenderTelemetry(renderDirWith("{ это не json"));
    expect(verdict.blocker).toBe("RENDER_TELEMETRY_MISSING");
  });

  it("пустой список записей после настоящего рендера — отказ", () => {
    // Классификатор вернёт на этом входе пустой список — ровно то же, что и
    // на здоровом документе. Отличить «нечего сказать» от «сказать нечего,
    // потому что канал оборван» может только сам файл.
    const verdict = judgeRenderTelemetry(telemetryDir([]));
    expect(verdict.blocker).toBe("RENDER_TELEMETRY_MISSING");
  });
});

describe("нечитаемая телеметрия", () => {
  /**
   * `inspectLayoutTelemetry` при отказе разбора строк отдаёт единственный
   * сентинел `{page: 0, code: "telemetry-read-error", severity: "WARNING"}` —
   * и пока ворота классифицировали его как обычную проблему, вердикт выходил
   * «блокера нет, есть предупреждение». Одна битая строка **перед** записью с
   * потерей — и потеря не осмотрена вовсе, а прогон уходит клиенту.
   */
  const DROPPED = {
    page: 6,
    name: "orion_risk_matrix_cards_p6",
    role: "cards",
    droppedBullets: 2,
    droppedLines: 0,
    requiredHeight: 5_500_000,
    availableHeight: 5_025_200,
  };

  it("битая строка перед настоящей потерей — отказ, а не предупреждение", () => {
    const verdict = judgeRenderTelemetry(
      renderDirWith(
        JSON.stringify({ version: "orion-layout-telemetry-v1", entries: [null, DROPPED] })
      )
    );
    expect(verdict.blocker).toBe("RENDER_TELEMETRY_MISSING");
    expect(verdict.warnings).toEqual([]);
  });

  it("список записей не массивом — тоже отказ", () => {
    const verdict = judgeRenderTelemetry(
      renderDirWith(JSON.stringify({ version: "orion-layout-telemetry-v1", entries: {} }))
    );
    expect(verdict.blocker).toBe("RENDER_TELEMETRY_MISSING");
  });

  it("отказ разбора никогда не выходит предупреждением", () => {
    for (const body of [
      JSON.stringify({ entries: [null] }),
      JSON.stringify({ entries: {} }),
      JSON.stringify({ entries: ["строка вместо записи"] }),
    ]) {
      const verdict = judgeRenderTelemetry(renderDirWith(body));
      expect(verdict.warnings.join("|")).not.toContain("telemetry-read-error");
      expect(verdict.blocker).toBe("RENDER_TELEMETRY_MISSING");
    }
  });
});

describe("токены предупреждений называют то, что случилось", () => {
  it("несработавшая мера шрифта не выдаётся за клип", () => {
    // `TABLE_WORD_BREAK` — «мера недоступна, обрезка не доказана». Клипом это
    // не является, и префикс `renderer-clip:` про него врал бы.
    const verdict = judgeRenderTelemetry(
      telemetryDir([
        {
          page: 9,
          name: "orion_table_rows_p9",
          role: "table",
          clipped: false,
          measurementUncertain: true,
        },
      ])
    );
    expect(verdict.blocker).toBeNull();
    expect(verdict.warnings).toEqual(["renderer-layout:page=9:TABLE_WORD_BREAK"]);
  });

  it("клип остаётся клипом", () => {
    const verdict = judgeRenderTelemetry(
      telemetryDir([
        {
          page: 7,
          name: "orion_text_body_p7",
          role: "text",
          clipped: true,
          requiredHeight: 1_400_000,
          availableHeight: 1_100_000,
        },
      ])
    );
    expect(verdict.warnings).toEqual(["renderer-clip:page=7:text-clipping"]);
  });
});
