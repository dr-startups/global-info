import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeRenderTelemetry } from "@/modules/digital-profile/services/render-telemetry-gate";

/**
 * Отказ рендерера называет блок и меру переполнения, а не только номер страницы.
 *
 * Прогон DPA-2026-0053 встал на «рендерер выбросил содержимое на страницах 62»
 * — и по этой строке нельзя ни понять, что именно не поместилось, ни оценить,
 * насколько. Классификатор телеметрии считает и блоки, и строки, и обе высоты;
 * ворота выбрасывали всё это и печатали один номер. Отказ, по которому нельзя
 * действовать, останавливает платный прогон на последнем шаге и ничего не
 * сообщает — то же правило уже записано у внутренних кодов в клиентском тексте.
 */

function telemetryDir(entries: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "render-drop-detail-"));
  writeFileSync(
    join(dir, "layout-telemetry.json"),
    JSON.stringify({ version: "orion-layout-telemetry-v1", entries }, null, 2),
    "utf8"
  );
  return dir;
}

const DROP = {
  page: 62,
  name: "orion_finding_cards_p62",
  role: "text",
  droppedBullets: 2,
  droppedLines: 0,
  requiredHeight: 1_480_000,
  availableHeight: 1_100_000,
  clipped: false,
};

describe("отказ по потерям рендерера", () => {
  it("называет блок, число потерянного и обе высоты", () => {
    const verdict = judgeRenderTelemetry(telemetryDir([DROP]));
    expect(verdict.blocker).toBe("CONTENT_DROPPED_BY_RENDERER");
    expect(verdict.detail).toContain("62");
    expect(verdict.detail).toContain("orion_finding_cards_p62");
    expect(verdict.detail).toContain("блоков=2");
    expect(verdict.detail).toContain("requiredHeight=1480000");
    expect(verdict.detail).toContain("availableHeight=1100000");
  });

  it("страниц много — перечисляются все, а подробность даётся по первым", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      ...DROP,
      page: 60 + i,
      name: `orion_block_p${60 + i}`,
    }));
    const verdict = judgeRenderTelemetry(telemetryDir(many));
    for (const page of [60, 61, 62, 63, 64, 65]) {
      expect(verdict.detail).toContain(String(page));
    }
    // Подробность не разрастается в простыню: она нужна, чтобы понять причину,
    // а не чтобы перечислить весь документ.
    expect(String(verdict.detail).length).toBeLessThan(900);
  });

  it("путь к телеметрии остаётся в отказе", () => {
    const dir = telemetryDir([DROP]);
    expect(judgeRenderTelemetry(dir).detail).toContain(dir);
  });
});
