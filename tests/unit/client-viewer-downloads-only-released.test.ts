/**
 * Клиент получает выпуск, а не черновик.
 *
 * Черновик собран для проверки аналитиком: в нём стоят материалы, которые ещё
 * могут оказаться о другом человеке, и темы со статусом «Требует
 * подтверждения». Отдать его клиенту значит отдать непроверенный документ,
 * который от проверенного ничем не отличается.
 *
 * Аналитику, ревьюеру и администратору черновик отдаётся всегда: он для них и
 * собран.
 */

import { describe, expect, it } from "vitest";
import { downloadDenialForRole } from "@/modules/digital-profile/services/report-release-state";

describe("кому какой документ отдаётся", () => {
  it("клиенту черновик не отдаётся, и причина названа", () => {
    const denial = downloadDenialForRole({ role: "CLIENT_VIEWER", released: false });
    expect(denial).toBe("REPORT_NOT_RELEASED");
  });

  it("клиенту выпуск отдаётся", () => {
    expect(downloadDenialForRole({ role: "CLIENT_VIEWER", released: true })).toBeNull();
  });

  it("аналитику, ревьюеру и администратору черновик отдаётся", () => {
    for (const role of ["ADMIN", "ANALYST", "REVIEWER", "SUPER_ADMIN"] as const) {
      expect(downloadDenialForRole({ role, released: false }), role).toBeNull();
    }
  });
});
