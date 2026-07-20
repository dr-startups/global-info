/**
 * Ported from smoke-report-material-freshness — pure freshness / diff helpers.
 * NETWORK_CALLS=0 (vitest.config env).
 */

import { describe, expect, it } from "vitest";
import {
  computeMaterialFreshness,
  diffMaterialKeys,
  formatRuDate,
  freshnessFootnote,
  preferNewerCollectedAt,
  reportDiffClientLine,
} from "../../src/modules/digital-profile/services/report-material-freshness";

describe("report-material-freshness helpers", () => {
  it("preferNewerCollectedAt keeps the later ISO", () => {
    expect(preferNewerCollectedAt("2024-01-01T00:00:00.000Z", "2025-06-15T12:00:00.000Z")).toBe(
      "2025-06-15T12:00:00.000Z"
    );
    expect(preferNewerCollectedAt(undefined, "2025-01-01T00:00:00.000Z")).toBe("2025-01-01T00:00:00.000Z");
    expect(preferNewerCollectedAt("1970-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z")).toBe(
      "2025-01-01T00:00:00.000Z"
    );
  });

  it("formatRuDate / freshnessFootnote use calendar dates", () => {
    expect(formatRuDate("2025-07-10T10:00:00.000Z")).toBe("10.07.2025");
    const f = computeMaterialFreshness([
      "2025-07-01T00:00:00.000Z",
      "2025-07-18T00:00:00.000Z",
      "1970-01-01T00:00:00.000Z",
    ]);
    expect(f).not.toBeNull();
    expect(String(freshnessFootnote(f!))).toMatch(
      /данные собраны 01\.07\.2025; самый свежий материал — 18\.07\.2025/
    );
  });

  it("diffMaterialKeys and reportDiffClientLine report added/removed", () => {
    const { added, removed } = diffMaterialKeys(["k-a", "k-b", "k-new"], ["k-a", "k-b", "k-gone"]);
    expect(added).toEqual(["k-new"]);
    expect(removed).toEqual(["k-gone"]);
    expect(
      reportDiffClientLine({
        addedCount: 1,
        removedCount: 1,
        previousJobId: "unified-prev-1",
      })
    ).toMatch(/Новых материалов с прошлого отчёта: 1, ушло из выдачи: 1/);
  });
});
