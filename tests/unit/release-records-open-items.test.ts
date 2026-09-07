/**
 * Выпуск помнит, сколько пунктов оставалось нерешёнными.
 *
 * Владелец разрешил выпускать при открытых пунктах (решение 7) — значит, отчёт
 * уходит клиенту с материалами, чью принадлежность никто не подтверждал. Тогда
 * на вопрос «что было известно на момент выпуска» надо отвечать данными, а не
 * восстанавливать их пересчётом через месяц: набор решений к тому времени
 * другой.
 *
 * У черновика числа нет намеренно: там оно не факт, а мгновение — пункты
 * решаются непрерывно, и записанное устареет раньше, чем его прочитают.
 */

import { describe, expect, it } from "vitest";
import {
  releaseStateAfterPrepare,
  type ReportReleaseState,
} from "@/modules/digital-profile/services/report-release-state";
import { openItemsOf } from "@/modules/digital-profile/services/review-sheet";

const NOW = "2026-09-07T12:00:00.000Z";
const requested: ReportReleaseState = {
  state: "draft",
  requested: { by: "analyst-1", at: "2026-09-07T11:00:00.000Z" },
};

describe("выпуск и открытые пункты", () => {
  it("выпуск записывает число открытых пунктов", () => {
    const next = releaseStateAfterPrepare({
      previous: requested,
      documentSha256: "abc",
      nowIso: NOW,
      openItems: 111,
    });
    expect(next.state).toBe("released");
    expect(next.openItems).toBe(111);
  });

  it("черновик числа открытых не несёт", () => {
    const next = releaseStateAfterPrepare({
      previous: undefined,
      documentSha256: "abc",
      nowIso: NOW,
      openItems: 111,
    });
    expect(next.state).toBe("draft");
    expect(next.openItems ?? null).toBeNull();
  });

  it("листа нет — переход не ломается, число просто не записано", () => {
    const next = releaseStateAfterPrepare({
      previous: requested,
      documentSha256: "abc",
      nowIso: NOW,
    });
    expect(next.state).toBe("released");
    expect(next.openItems ?? null).toBeNull();
  });

  it("считает открытые сам лист, а не второй обход", () => {
    const sheet = {
      version: "review-sheet-v1" as const,
      caseId: "case-1",
      decisionsDigest: "d",
      summary: {
        evidence: { total: 160, open: 111, framed: 5 },
        finding: { total: 12, open: 1 },
        compliance: { total: 2, open: 2 },
      },
      items: [],
    };
    expect(openItemsOf(sheet)).toBe(114);
    expect(openItemsOf(null)).toBeNull();
  });
});
