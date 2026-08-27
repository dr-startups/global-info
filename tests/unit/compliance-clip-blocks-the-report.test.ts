/**
 * Обрезка карточки комплаенса — блокер выдачи, а не предупреждение.
 *
 * Общее правило («клип — предупреждение») верно и остаётся: клип означает
 * сработавшую защиту — понижен кегль, подрезано предложение, — а пропавшее
 * содержимое считается отдельно и блокирует само. Мера к тому же
 * консервативна, и блокировка по её предсказанию останавливала бы здоровые
 * прогоны.
 *
 * Исключение узкое и названное: на странице комплаенс-раздела обрезается не
 * хвост предложения, а строка карточки записи — печатного носителя правила
 * «совпадение уходит аналитику целиком». На стр. 69 живого отчёта так пропала
 * строка «Также числится как», а прогон доехал до готового отчёта.
 *
 * Страница узнаётся по разделу слайда и по имени фигуры, а не по номеру:
 * номера страниц двигает любая пересборка.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeRenderTelemetry } from "@/modules/digital-profile/services/render-telemetry-gate";

function telemetryDir(entries: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "compliance-clip-gate-"));
  writeFileSync(
    join(dir, "layout-telemetry.json"),
    JSON.stringify({ version: "orion-layout-telemetry-v1", entries }, null, 2),
    "utf8"
  );
  return dir;
}

/** Запись телеметрии стр. 69 живого отчёта, дословно по бандлу. */
const COMPLIANCE_CLIP = {
  page: 69,
  name: "orion_search_table_p69",
  role: "text",
  requiredHeight: 4_627_880,
  availableHeight: 4_602_385,
  measuredLines: 21,
  clipped: true,
  measurementUncertain: false,
};

/** Тот же клип на странице выдачи — там правило прежнее. */
const SERP_CLIP = {
  page: 22,
  name: "orion_search_table_p22",
  role: "text",
  requiredHeight: 3_600_000,
  availableHeight: 3_510_000,
  clipped: true,
  measurementUncertain: false,
};

const CLEAN = {
  page: 3,
  name: "orion_text_body_p3",
  role: "text",
  requiredHeight: 197_815,
  availableHeight: 1_100_000,
  clipped: false,
  measurementUncertain: false,
};

describe("клип на странице комплаенса блокирует выдачу", () => {
  it("обрезанная карточка записи — блокер с названной причиной", () => {
    const verdict = judgeRenderTelemetry(telemetryDir([CLEAN, COMPLIANCE_CLIP]), {
      compliancePages: [69],
    });
    expect(verdict.blocker).toBe("COMPLIANCE_CARD_CLIPPED");
    expect(verdict.detail).toContain("69");
    expect(verdict.detail).toContain("комплаенс");
  });

  it("страница узнаётся по разделу, а не по номеру", () => {
    // Тот же клип на той же 69-й странице, но раздел там не комплаенс —
    // правило прежнее.
    const verdict = judgeRenderTelemetry(telemetryDir([CLEAN, COMPLIANCE_CLIP]), {
      compliancePages: [52, 53],
    });
    expect(verdict.blocker).toBeNull();
    expect(verdict.warnings).toContain("renderer-clip:page=69:TABLE_ROW_PARTIALLY_VISIBLE");
  });

  it("клип на прочих страницах остаётся предупреждением", () => {
    const verdict = judgeRenderTelemetry(telemetryDir([CLEAN, SERP_CLIP]), {
      compliancePages: [69],
    });
    expect(verdict.blocker).toBeNull();
    expect(verdict.warnings).toEqual(["renderer-clip:page=22:TABLE_ROW_PARTIALLY_VISIBLE"]);
  });

  it("без списка страниц комплаенса правило прежнее", () => {
    // Реплей старого рендера и вызовы, которым раздел неизвестен: сказать
    // «это карточка записи» не может никто, и выдумывать блокер нельзя.
    const verdict = judgeRenderTelemetry(telemetryDir([CLEAN, COMPLIANCE_CLIP]));
    expect(verdict.blocker).toBeNull();
    expect(verdict.warnings).toContain("renderer-clip:page=69:TABLE_ROW_PARTIALLY_VISIBLE");
  });

  it("потеря содержимого сильнее: она блокирует и на комплаенс-странице", () => {
    const dropped = { ...COMPLIANCE_CLIP, clipped: false, droppedBullets: 1, droppedLines: 0 };
    const verdict = judgeRenderTelemetry(telemetryDir([dropped]), { compliancePages: [69] });
    expect(verdict.blocker).toBe("CONTENT_DROPPED_BY_RENDERER");
  });

  it("прозаический клип на той же странице остаётся предупреждением", () => {
    // Узость исключения — его половина. Вводный абзац страницы комплаенса
    // обрезается той же консервативной мерой, что и на любом текстовом пути, и
    // блокировка по ней остановила бы здоровый оплаченный прогон из-за
    // подрезанного предложения. Обрезается там хвост фразы, а не строка записи.
    const proseClip = { ...COMPLIANCE_CLIP, name: "orion_text_body_p69" };
    const verdict = judgeRenderTelemetry(telemetryDir([CLEAN, proseClip]), {
      compliancePages: [69],
    });
    expect(verdict.blocker).toBeNull();
    expect(verdict.warnings).toContain("renderer-clip:page=69:text-clipping");
  });

  it("оба кода клипа таблицы блокируют одинаково", () => {
    // Имя фигуры здесь синтетическое: живой рендерер сегодня не называет ни
    // одну фигуру телеметрии словом «status», и `TABLE_STATUS_CLIPPED` берётся
    // только из словаря классификатора. Правило судит коды, а не имена фигур, и
    // два кода одного клипа таблицы («не влезла строка записи» и «не влез её
    // статус») обязаны судиться одинаково: разница между ними не по существу.
    const statusClip = { ...COMPLIANCE_CLIP, name: "orion_status_badge_p69" };
    const verdict = judgeRenderTelemetry(telemetryDir([statusClip]), { compliancePages: [69] });
    expect(verdict.blocker).toBe("COMPLIANCE_CARD_CLIPPED");
  });
});
