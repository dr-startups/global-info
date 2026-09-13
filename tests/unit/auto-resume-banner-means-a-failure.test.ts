/**
 * Плашка «система сама вернётся к работе» — про возврат после сбоя.
 *
 * QA 14.09.2026: на здоровом прогоне сразу после старта шапка дела печатала
 * «Сбор продолжается: система сама вернётся к работе, вмешательство не
 * требуется. Следующая попытка в …». `autoResumeState` считает любой
 * ожидающий шаг с назначенным сроком «возвращением» — этим прячется кнопка
 * восстановления, и это верно. Но слова плашки обещают возврат после сбоя,
 * и без сбоя они лгут: показывать её можно, только когда есть от чего
 * возвращаться.
 */

import { describe, expect, it } from "vitest";
import { autoResumeBannerVisible } from "@/modules/digital-profile/client/auto-resume-banner";

describe("плашка авто-возобновления", () => {
  it("здоровый ожидающий прогон — плашки нет", () => {
    expect(autoResumeBannerVisible({ autoResumePending: true, stage: "BASE_COLLECTION", lastErrorCode: null })).toBe(false);
    expect(autoResumeBannerVisible({ autoResumePending: true, stage: "ARSENKIN_ENRICHMENT", lastErrorCode: null })).toBe(false);
  });

  it("повторяемый отказ с назначенным повтором — плашка есть", () => {
    expect(autoResumeBannerVisible({ autoResumePending: true, stage: "FAILED_RETRYABLE", lastErrorCode: "ARSENKIN_ENRICHMENT_FAILED" })).toBe(true);
    expect(autoResumeBannerVisible({ autoResumePending: true, stage: "ARSENKIN_ENRICHMENT", lastErrorCode: "ARSENKIN_POLL_ATTEMPTS_EXCEEDED" })).toBe(true);
  });

  it("без назначенного повтора плашки нет, какой бы ни была стадия", () => {
    expect(autoResumeBannerVisible({ autoResumePending: false, stage: "FAILED_RETRYABLE", lastErrorCode: "X" })).toBe(false);
    expect(autoResumeBannerVisible({ autoResumePending: false, stage: "FAILED_TERMINAL", lastErrorCode: "X" })).toBe(false);
  });
});
