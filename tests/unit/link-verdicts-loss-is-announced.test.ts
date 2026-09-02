/**
 * Купленные вердикты, которые не удалось переиспользовать, заменяются громко.
 *
 * Остаточная ветка реюза: файл на диске есть, решения в нём есть, но взять их
 * нельзя — чужая версия схемы, неразобранное содержимое. Тогда прогон идёт
 * обычным путём (по флагу), и что бы из этого ни вышло, купленное подменено.
 * Молча такое не проходит ни в одном из двух исходов: артефакт несёт
 * `superseded`, в предупреждениях качества появляется
 * `link-verdicts-lost:<причина>`, а в логе — строка о замене. Тихой заменой
 * куплённого шаг и лечится, поэтому «новый результат непуст» оправданием не
 * является: за него заплатили второй раз, а прежние решения исчезли.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCanonicalReportPrepare } from "@/modules/digital-profile/services/canonical-report-prepare";
import {
  boughtLinkVerdictsArtifact,
  linkVerdict,
} from "../fixtures/link-verdict-artifact";
import {
  TINY_CASE_ID,
  runTinyAnalytics,
  tinyPrepareInput,
} from "../fixtures/tiny-canonical-prepare";

/** Купленный артефакт чужой схемы: переиспользовать нельзя, потерять — жалко. */
function seedForeignSchemaArtifact(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "link-verdicts.json"),
    `${JSON.stringify(
      boughtLinkVerdictsArtifact({
        caseId: TINY_CASE_ID,
        verdicts: [linkVerdict(), linkVerdict({ evidenceRef: "inventory:obs-a2" })],
        schemaVersion: "link-verdict-v0",
      }),
      null,
      2
    )}\n`,
    "utf8"
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.DIGITAL_PROFILE_LINK_READING;
});

describe("потеря купленных вердиктов объявляется", () => {
  it("конвейер помечает артефакт как вытесненный и возвращает предупреждение", async () => {
    const dir = mkdtempSync(join(tmpdir(), "link-verdicts-lost-"));
    seedForeignSchemaArtifact(dir);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    const res = await runTinyAnalytics(dir);

    const artifact = JSON.parse(readFileSync(join(dir, "link-verdicts.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(artifact.verdicts).toEqual([]);
    expect(artifact.superseded).toEqual({
      reason: "schema-mismatch",
      previousVerdictCount: 2,
    });
    expect(res.qualityWarnings).toContain("link-verdicts-lost:schema-mismatch");
    expect(errors.join("\n")).toMatch(/link-verdicts|вердикт/i);
  });

  it("замена купленного новой покупкой объявляется так же громко", async () => {
    // Флаг включён — прогон читает страницы заново и получает свои решения.
    // Прежние при этом исчезают, и это обязано быть видно: иначе бамп версии
    // схемы однажды молча сотрёт оплаченное чтение живого дела.
    process.env.DIGITAL_PROFILE_LINK_READING = "1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("страница недоступна");
      })
    );
    const dir = mkdtempSync(join(tmpdir(), "link-verdicts-replaced-"));
    seedForeignSchemaArtifact(dir);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    const res = await runTinyAnalytics(dir);

    const artifact = JSON.parse(readFileSync(join(dir, "link-verdicts.json"), "utf8")) as {
      verdicts: unknown[];
      superseded?: unknown;
    };
    expect(artifact.verdicts.length).toBeGreaterThan(0);
    expect(artifact.superseded).toEqual({
      reason: "schema-mismatch",
      previousVerdictCount: 2,
    });
    expect(res.qualityWarnings).toContain("link-verdicts-lost:schema-mismatch");
    expect(errors.join("\n")).toMatch(/link-verdicts-lost:schema-mismatch/);
  });

  it("переиспользованный прогон со сломанным чтением остаётся слышен", async () => {
    // Заморозить результат сломанного чтения можно, спрятать его нельзя:
    // ветка реюза не должна гасить тревогу, ради которой она заведена.
    const dir = mkdtempSync(join(tmpdir(), "link-verdicts-broken-reuse-"));
    const artifact = boughtLinkVerdictsArtifact({
      caseId: TINY_CASE_ID,
      verdicts: [
        linkVerdict({ readFailure: "blocked", tone: "neutral", quotes: [] }),
        linkVerdict({
          evidenceRef: "inventory:obs-a2",
          readFailure: "timeout",
          tone: "neutral",
          quotes: [],
        }),
      ],
    });
    artifact.readOk = 0;
    artifact.readingBroken = true;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "link-verdicts.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    await runTinyAnalytics(dir);

    expect(errors.join("\n")).toMatch(/ЧТЕНИЕ НЕ РАБОТА/i);
  });

  it("подготовка отчёта доносит потерю до предупреждений качества", async () => {
    const root = mkdtempSync(join(tmpdir(), "link-verdicts-lost-prepare-"));
    seedForeignSchemaArtifact(join(root, "analytics"));

    const res = await runCanonicalReportPrepare(await tinyPrepareInput(root));

    expect(res.qualityWarnings ?? []).toContain("link-verdicts-lost:schema-mismatch");
  });
});
