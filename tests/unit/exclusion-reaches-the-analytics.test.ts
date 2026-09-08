/**
 * Снятое решением проверки не доезжает до выводов — ни материал, ни тема.
 *
 * Шаг 0065 снимал материал в загрузчике входов деки, а шаг 0068 — тему там же.
 * Но резюме, состав тем и канонические утверждения считаются раньше, в
 * конвейере аналитики, и туда снятое продолжало попадать: исполнительное резюме
 * могло процитировать снятый материал и назвать снятую тему. «Не печатается
 * нигде» было неправдой для первых страниц отчёта.
 *
 * Теперь аналитика считается по материалам без снятых, а реестр расположения
 * по-прежнему видит все и называет снятые своей причиной: «не анализировали»
 * и «не собирали» — разные утверждения.
 *
 * Здесь же проверяется, что снимок отчёта базы переживает сохранение: подготовка
 * писала на диск активы **до** добавления снимков комплаенса, и на любом
 * возобновлении снимок исчезал.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCanonicalReportPrepare } from "@/modules/digital-profile/services/canonical-report-prepare";
import { resolvePreparePrismaBundle } from "@/modules/digital-profile/services/prepare-prisma-bundle";
import {
  canonicalThemeIdOfReviewKey,
  themeLabelRu,
} from "@/modules/digital-profile/orion-golden/analytics/canonical-themes";
import { reviewThemeKeyOf } from "@/modules/digital-profile/services/review-sheet";
import { TINY_ADVERSE_URL, tinyPrepareInput } from "../fixtures/tiny-canonical-prepare";

/** Ключ материала — тот же, которым лист проверки ключует пункт. */
const ADVERSE_KEY = "url:di.se/holmstrom-tax";
const DESCRIPTION = {
  whatItShows: "Карточка профиля LexisNexis с одной публикацией о налоговой проверке.",
  whyItMatters: "Публикация связывает проверяемое лицо с налоговым спором.",
  whatToDo: "Запросить первоисточник и полную карточку записи.",
};

type Decision = {
  id: string;
  caseId: string;
  itemKind: string;
  itemKey: string;
  decisionKind: string;
  status: string;
  isActive: boolean;
  decidedAt: Date;
};

function prismaWith(decisions: Decision[]) {
  return {
    searchResult: { count: async () => 0, findMany: async () => [] },
    searchSurfaceItem: { count: async () => 0 },
    databaseProfile: {
      findMany: async () => [
        {
          id: "hit-lexis-visual",
          provider: "LEXISNEXIS",
          importMethod: "MANUAL",
          hitSource: "MANUAL",
          matchedName: "LexisNexis approved screenshots",
          reviewStatus: "MATCH_CONFIRMED",
          summary: "Approved LexisNexis visual pages (1) for report inclusion.",
          rawMetadataSafe: {
            complianceVisual: {
              kind: "lexisnexis_report",
              approved: true,
              reportDate: "2026-08-14",
              description: DESCRIPTION,
              // Рендер в этом тесте поддельный, поэтому байты картинки могут
              // быть любыми — важен только порог «это не заглушка».
              renderedPages: [{ pageNumber: 1, imageBase64: "A".repeat(1200) }],
            },
          },
        },
      ],
    },
    complianceScreeningRun: { findMany: async () => [] },
    riskFinding: { findMany: async () => [] },
    wikipediaCheck: { findMany: async () => [] },
    serpCapture: { findMany: async () => [] },
    reviewDecision: {
      findMany: async () => decisions,
      updateMany: async () => ({ count: 0 }),
      create: async (args: { data: unknown }) => args.data,
    },
  };
}

function decision(over: Partial<Decision> & { itemKind: string; itemKey: string }): Decision {
  return {
    id: `d-${over.itemKey}`,
    caseId: "case-tiny-prepare",
    decisionKind: "presence",
    status: "EXCLUDED",
    isActive: true,
    decidedAt: new Date("2026-09-07T10:00:00.000Z"),
    ...over,
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Артефакты аналитики, из которых собираются печатаемые выводы. */
const ANALYTICS_ARTIFACTS = [
  "surface-analysis.json",
  "verified-finding-bundle.json",
  "ambiguous-findings.json",
  "uncategorized-materials.json",
  "canonical-claims.json",
  "representative-evidence-selection.json",
  "executive-summary-input.json",
  "client-summary-pack.json",
];

/** Ссылки наблюдений снимаемого материала — из набора самого прогона. */
function adverseRefs(root: string): string[] {
  const dataset = readJson<{ observations: Array<{ url?: string; evidenceRefs?: string[] }> }>(
    join(root, "analytics", "composite-serp-observations.json")
  );
  return dataset.observations
    .filter((o) => String(o.url ?? "").replace(/\/$/u, "") === TINY_ADVERSE_URL)
    .flatMap((o) => o.evidenceRefs ?? []);
}

async function prepare(decisions: Decision[]) {
  const root = mkdtempSync(join(tmpdir(), "prepare-exclusion-"));
  const prisma = await resolvePreparePrismaBundle(prismaWith(decisions) as never);
  const res = await runCanonicalReportPrepare(await tinyPrepareInput(root, { prisma }));
  expect(res.ok).toBe(true);
  const text = (name: string) => readFileSync(join(root, "analytics", name), "utf8");
  return { root, text };
}

describe("снятое решением проверки не доезжает до выводов", () => {
  it("снятый материал не встречается в находках и резюме, а реестр называет его снятым", async () => {
    const before = await prepare([]);
    // Ссылка наблюдения — точный признак: домен в артефактах может стоять в
    // другой форме, а ссылка одна на всех.
    const refs = adverseRefs(before.root);
    expect(refs.length).toBeGreaterThanOrEqual(1);
    // Где материал стоял до снятия — там его и не должно быть после. Список
    // берётся у самого прогона: в какую корзину синтез положил материал в
    // этой фикстуре, тест не угадывает, а проверяет, что до снятия он дошёл
    // дальше поверхностей — иначе область анализа осталась бы непроверенной.
    const carrying = ANALYTICS_ARTIFACTS.filter((name) =>
      refs.some((ref) => before.text(name).includes(ref))
    );
    expect(carrying).toContain("surface-analysis.json");
    expect(carrying.length).toBeGreaterThanOrEqual(2);

    const after = await prepare([decision({ itemKind: "evidence", itemKey: ADVERSE_KEY })]);
    for (const name of carrying) {
      for (const ref of refs) expect(after.text(name), name).not.toContain(ref);
    }

    const ledger = readJson<{
      entries: Array<{ rawObservationId: string; disposition: string; reasonCode: string }>;
    }>(join(after.root, "analytics", "observation-disposition-ledger.json"));
    const removed = ledger.entries.filter((e) => e.disposition === "EXCLUDE_ANALYST");
    expect(removed.map((e) => e.rawObservationId).sort()).toEqual([...refs].sort());
    expect(removed.every((e) => e.reasonCode === "analyst_excluded")).toBe(true);
  });

  it("снятая тема исчезает из находок и резюме, а её материалы остаются", async () => {
    const before = await prepare([]);
    const bundle = readJson<{ findings: Array<{ findingId: string; theme: string }> }>(
      join(before.root, "analytics", "verified-finding-bundle.json")
    );
    expect(bundle.findings.length).toBeGreaterThanOrEqual(1);
    const target = bundle.findings[0]!;
    const themeKey = reviewThemeKeyOf(target.findingId);
    expect(themeKey.startsWith("theme:")).toBe(true);

    const after = await prepare([decision({ itemKind: "finding", itemKey: themeKey })]);
    const afterBundle = readJson<{ findings: Array<{ findingId: string }> }>(
      join(after.root, "analytics", "verified-finding-bundle.json")
    );
    expect(afterBundle.findings.map((f) => reviewThemeKeyOf(f.findingId))).not.toContain(themeKey);
    expect(after.text("executive-summary-input.json")).not.toContain(target.theme);
    /*
     * Резюме клиента строится из утверждений, а не из находок, и снятая тема
     * возвращалась через утверждения по непокрытым материалам (шаг 0070).
     * Поэтому сверяются и утверждения, и то, что печатает резюме.
     */
    const canonicalId = canonicalThemeIdOfReviewKey(themeKey);
    expect(canonicalId).not.toBeNull();
    const claims = readJson<{ claims: Array<{ themeIds: string[] }> }>(
      join(after.root, "analytics", "canonical-claims.json")
    );
    expect(claims.claims.filter((c) => c.themeIds.includes(String(canonicalId)))).toEqual([]);
    expect(after.text("composed-client-summary.json")).not.toContain(themeLabelRu(canonicalId!));
    // Материалы темы никуда не делись: реестр не считает их снятыми.
    const ledger = readJson<{ entries: Array<{ disposition: string }> }>(
      join(after.root, "analytics", "observation-disposition-ledger.json")
    );
    expect(ledger.entries.some((e) => e.disposition === "EXCLUDE_ANALYST")).toBe(false);
  });

  it("снимок отчёта базы переживает сохранение активов", async () => {
    const { root } = await prepare([]);
    const slots = readJson<{
      visualAssets: Record<string, Array<{ assetRef: string; analystDescription?: { whatItShows?: string }; sourceLine?: string }>>;
    }>(join(root, "visual-assets-by-slot.json"));
    const lexis = slots.visualAssets.p35_lexis_visual?.[0];
    expect(lexis?.assetRef).toBe("lexisnexis_report_1");
    expect(lexis?.analystDescription?.whatItShows).toBe(DESCRIPTION.whatItShows);
    expect(lexis?.sourceLine).toBe("Отчёт LexisNexis от 14.08.2026");

    const assets = readJson<Array<{ assetRef: string }>>(join(root, "report-assets.json"));
    expect(assets.map((a) => a.assetRef)).toContain("lexisnexis_report_1");
  });
});
