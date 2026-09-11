/**
 * Новая попытка шага получает свежий бюджет холостых опросов.
 *
 * Прогон DPA-2026-0054 (11.09.2026): шаг `ARSENKIN_ENRICHMENT` исчерпал бюджет
 * простоя («41 опросов подряд», повторяемый отказ) в 09:43:18 и к 09:45 сжёг
 * шесть попыток из десяти — по одной в полминуты, без единого нового опроса.
 * Перед попыткой снимался только вердикт прошлой (`stageForRetryAttempt`, шаг
 * 28.07), а счётчик простоя `pollAttempt: 40` оставался на джобе: первый же
 * опрос давал 41, «исчерпано», попытка потрачена.
 *
 * «Ожидание — не попытка»: попытка, которой не дали подождать, отказом не
 * является. Патч перед попыткой собирается одной функцией и обнуляет счётчик
 * простоя вместе с вердиктом. Общий бюджет ожидания (`enrichmentWaitStartedAt`)
 * не трогается: он ограничивает ожидание в целом и остановит повторы честно.
 */

import { describe, expect, it } from "vitest";
import { retryAttemptPatch } from "@/modules/digital-profile/workflow/unified-step-handlers";

describe("патч перед новой попыткой шага", () => {
  it("повторяемый отказ: стадия шага, снятый вердикт и обнулённый счётчик простоя", () => {
    const patch = retryAttemptPatch("ARSENKIN_ENRICHMENT", "FAILED_RETRYABLE");
    expect(patch).toEqual({
      stage: "ARSENKIN_ENRICHMENT",
      lastError: null,
      lastErrorCode: null,
      pollAttempt: 0,
      nextPollAt: null,
    });
  });

  it("общий бюджет ожидания попыткой не сбрасывается", () => {
    const patch = retryAttemptPatch("ARSENKIN_ENRICHMENT", "FAILED_RETRYABLE");
    expect(patch && "enrichmentWaitStartedAt" in patch).toBe(false);
  });

  it("терминальный отказ, отмена и обычная стадия патча не получают", () => {
    expect(retryAttemptPatch("ARSENKIN_ENRICHMENT", "FAILED_TERMINAL")).toBeNull();
    expect(retryAttemptPatch("ARSENKIN_ENRICHMENT", "CANCELLED")).toBeNull();
    expect(retryAttemptPatch("ARSENKIN_ENRICHMENT", "ARSENKIN_ENRICHMENT")).toBeNull();
    expect(retryAttemptPatch("НЕТ_ТАКОГО_ШАГА", "FAILED_RETRYABLE")).toBeNull();
  });
});
