/**
 * REMEDIATION §3.1 — finding-themes config resolver.
 * Run: npm run smoke:finding-themes-config
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach } from "node:test";

import {
  FindingThemesConfigError,
  compileFindingThemesConfig,
  getDefaultFindingThemesConfigJson,
  resetFindingThemesConfigCache,
  resolveFindingThemesConfig,
} from "../src/modules/digital-profile/config/finding-themes";
import { getFindingThemes } from "../src/modules/digital-profile/config/finding-themes";
import { FINDING_THEMES } from "../src/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { ADVERSE_PATTERNS } from "../src/modules/digital-profile/orion-golden/analytics/surface-analyzers";

beforeEach(() => {
  resetFindingThemesConfigCache();
});

describe("finding-themes config (§3.1)", () => {
  it("defaults compile and expose universal themes without transport-contour tuning", () => {
    const cfg = resolveFindingThemesConfig({ overridePath: null });
    assert.equal(cfg.source, "default");
    const ids = cfg.themes.map((t) => t.themeId);
    assert.ok(ids.includes("criminal_legal"));
    assert.ok(ids.includes("pep_rca_watchlist"));
    assert.ok(ids.includes("financial_claims"));
    assert.ok(ids.includes("business_profile"));
    const security = cfg.themes.find((t) => t.themeId === "security_scrutiny")!;
    assert.equal(security.keywords.test("транспортный контур субъекта"), false);
    assert.equal(security.keywords.test("ФСБ проводит проверку"), true);
    assert.equal(cfg.adversePatterns.test("санкции и уголовное дело"), true);
  });

  it("JSON override replaces themes (and caches per path)", () => {
    const root = mkdtempSync(join(tmpdir(), "finding-themes-"));
    const cfgDir = join(root, "config");
    mkdirSync(cfgDir, { recursive: true });
    const override = getDefaultFindingThemesConfigJson();
    override.themes = [
      {
        themeId: "custom_only",
        label: "Кастомная тема",
        keywords: "уникальный\\s+маркер",
        flags: "iu",
        baseRisk: "high",
        recommendedAction: "Проверить.",
      },
    ];
    writeFileSync(join(cfgDir, "finding-themes.json"), JSON.stringify(override, null, 2), "utf8");

    const cfg = resolveFindingThemesConfig({ storageRoot: root });
    assert.equal(cfg.source, "override");
    assert.equal(cfg.themes.length, 1);
    assert.equal(cfg.themes[0]!.themeId, "custom_only");
    assert.equal(cfg.themes[0]!.keywords.test("уникальный маркер в тексте"), true);

    const again = resolveFindingThemesConfig({ storageRoot: root });
    assert.equal(again.themes[0]!.themeId, "custom_only");
  });

  it("broken regex fail-fast", () => {
    assert.throws(
      () =>
        compileFindingThemesConfig(
          {
            ...getDefaultFindingThemesConfigJson(),
            adversePatterns: "(unclosed",
          },
          { source: "override", overridePath: null }
        ),
      (err: unknown) =>
        err instanceof FindingThemesConfigError && /invalid regex adversePatterns/i.test(err.message)
    );
  });

  it("FINDING_THEMES proxy and ADVERSE_PATTERNS stay wired to resolver", () => {
    resetFindingThemesConfigCache();
    assert.equal(FINDING_THEMES.length, getFindingThemes().length);
    assert.equal(FINDING_THEMES.find((t) => t.themeId === "criminal_legal")?.themeId, "criminal_legal");
    assert.equal(ADVERSE_PATTERNS.test("уголовное дело"), true);
  });

  it("default theme keyword coverage matches pre-refactor labels for core buckets", () => {
    const cfg = resolveFindingThemesConfig({ overridePath: null });
    const byId = new Map(cfg.themes.map((t) => [t.themeId, t]));
    const samples: Array<[string, string]> = [
      ["criminal_legal", "уголовное дело и арест"],
      ["pep_rca_watchlist", "санкции и PEP watchlist"],
      ["political_exposure", "политические связи депутата"],
      ["offshore_corporate", "offshore Cyprus ownership"],
      ["family_associates", "жена и сын предпринимателя"],
      ["business_profile", "биография бизнесмена forbes"],
      ["financial_claims", "банкротство и взыскание долга"],
    ];
    for (const [id, text] of samples) {
      assert.ok(byId.get(id)?.keywords.test(text), `${id} should match: ${text}`);
    }
  });
});
