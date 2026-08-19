/**
 * Не снятый стоп-маркер слышен, а не молчалив.
 *
 * Пересборка снимает стоп-маркер инвалидации: он говорил о деке, которой
 * больше нет. Если уборка не удалась, маркер остаётся навсегда — и каждое
 * следующее «возобновить с рендера» отбивается им и платит за аналитику и обе
 * стадии GPT, то есть получает ровно тот исход, который уборка и должна была
 * предотвратить. Молчаливая уборка делает эту потерю неотличимой от нормы.
 *
 * Отказ файловой системы здесь подставляется подменой `node:fs`: тесты идут
 * под root, и правами доступа его не подделать.
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCanonicalReportPrepare } from "@/modules/digital-profile/services/canonical-report-prepare";
import { tinyPrepareInput } from "../fixtures/tiny-canonical-prepare";

const { MARKER_NAME } = vi.hoisted(() => ({ MARKER_NAME: "assembled-deck.json.stale.json" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    unlinkSync: (path: Parameters<typeof actual.unlinkSync>[0]) => {
      if (String(path).endsWith(MARKER_NAME)) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      actual.unlinkSync(path);
    },
  };
});

describe("уборка стоп-маркера", () => {
  it("несостоявшаяся — называет себя в предупреждениях подготовки", async () => {
    const root = mkdtempSync(join(tmpdir(), "stale-marker-unlink-"));
    const seeded = await runCanonicalReportPrepare(await tinyPrepareInput(root));
    expect(seeded.ok).toBe(true);

    writeFileSync(
      join(root, MARKER_NAME),
      JSON.stringify({ version: "downstream-stale-marker-v1", doNotReuse: true }),
      "utf8"
    );

    const res = await runCanonicalReportPrepare(await tinyPrepareInput(root));
    expect(res.ok).toBe(true);
    expect(res.qualityWarnings ?? []).toContain("deck-stale-marker-not-cleared");
  });
});
