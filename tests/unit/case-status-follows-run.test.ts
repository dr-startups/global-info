import { describe, expect, it } from "vitest";
import { caseStatusForStage } from "../../src/modules/digital-profile/services/unified-case-status-sync";

/**
 * Шаг 11.3 плана (docs/rework/11-workflow-ux-and-false-failures.md).
 *
 * Кейс, чей прогон дошёл до REPORT_READY, в списке и в шапке значился DRAFT,
 * а рядом печатался второй статус — «Unified: Report ready». Два разных
 * ответа на один вопрос в одной строке.
 */

describe("статус кейса следует за стадией прогона", () => {
  it("черновик переходит в сбор, как только прогон начался", () => {
    expect(caseStatusForStage("BASE_COLLECTION", "DRAFT")).toBe("COLLECTING");
    expect(caseStatusForStage("ARSENKIN_ENRICHMENT", "DRAFT")).toBe("COLLECTING");
    expect(caseStatusForStage("ORION_PREPARE", "DRAFT")).toBe("COLLECTING");
  });

  it("готовый отчёт переводит кейс в REPORT_READY", () => {
    expect(caseStatusForStage("REPORT_READY", "COLLECTING")).toBe("REPORT_READY");
    expect(caseStatusForStage("COMPLETED_PARTIAL", "COLLECTING")).toBe("REPORT_READY");
  });

  it("не повторяет уже установленный статус", () => {
    expect(caseStatusForStage("REPORT_READY", "REPORT_READY")).toBeNull();
    expect(caseStatusForStage("BASE_COLLECTION", "COLLECTING")).toBeNull();
  });

  it("не понижает кейс, уже дошедший до отчёта или проверки", () => {
    // Новый прогон по готовому кейсу не отправляет его обратно в «сбор»,
    // пока не даст результат: иначе список кейсов мигал бы туда-обратно.
    expect(caseStatusForStage("BASE_COLLECTION", "REPORT_READY")).toBeNull();
    expect(caseStatusForStage("ARSENKIN_ENRICHMENT", "REVIEW")).toBeNull();
  });

  it("не трогает статусы, которые ставит человек", () => {
    expect(caseStatusForStage("REPORT_READY", "CLOSED")).toBeNull();
    expect(caseStatusForStage("BASE_COLLECTION", "ARCHIVED")).toBeNull();
  });

  it("восстановимый отказ — это идущая работа, а не возврат в черновик", () => {
    expect(caseStatusForStage("FAILED_RETRYABLE", "DRAFT")).toBe("COLLECTING");
    expect(caseStatusForStage("FAILED_RETRYABLE", "COLLECTING")).toBeNull();
  });

  it("терминальный отказ статус кейса не меняет", () => {
    // Кейс остаётся там, где был: отчёта нет, но и сбор больше не идёт.
    expect(caseStatusForStage("FAILED_TERMINAL", "COLLECTING")).toBeNull();
    expect(caseStatusForStage("CANCELLED", "COLLECTING")).toBeNull();
  });

  it("неизвестная стадия и пустые значения ничего не ломают", () => {
    expect(caseStatusForStage(null, "DRAFT")).toBeNull();
    expect(caseStatusForStage("BASE_COLLECTION", null)).toBe("COLLECTING");
    expect(caseStatusForStage("", "")).toBeNull();
  });
});
