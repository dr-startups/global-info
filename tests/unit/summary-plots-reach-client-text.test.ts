/**
 * Сюжет доезжает до клиента целиком.
 *
 * Между строкой артефакта и страницей отчёта четыре участника: пакет,
 * композер, семантическая укладка и построитель слайдов резюме. Ветку сюжетов
 * не исполняет ни один офлайн-контур, поэтому цепочка проверяется здесь целиком
 * — от вердиктов до снимка клиентского текста, тем же снимком, каким закреплён
 * золотой кейс.
 *
 * Второе свойство: сюжет, который не помещается в буллет, делится на части, а
 * не режется. Молча потерянный текст — это дефект, а не сокращение.
 */

import { describe, expect, it } from "vitest";
import { buildClientSummaryPack } from "@/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import { composeClientSummary } from "@/modules/digital-profile/orion-golden/analytics/client-summary-composer";
import {
  buildExecutiveSummaryFromComposed,
  fragmentScope,
} from "@/modules/digital-profile/orion-golden/deck-sections";
import { paginateComposedClientSummary } from "@/modules/digital-profile/orion-golden/deck-sections/semantic-summary-pagination";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { CanonicalClaimsBundle } from "@/modules/digital-profile/orion-golden/contracts/canonical-claim";
import type { ClientSummaryPack } from "@/modules/digital-profile/orion-golden/contracts/client-summary-pack";
import type {
  LinkVerdict,
  VerdictThemeSummary,
} from "@/modules/digital-profile/orion-golden/contracts/link-verdict";
import type { RepresentativeEvidenceSelection } from "@/modules/digital-profile/orion-golden/contracts/representative-evidence";
import { extractClientText } from "../../scripts/lib/client-text-snapshot";

const NO_CLAIMS = { claims: [] } as unknown as CanonicalClaimsBundle;
const NO_SELECTION = {
  materialThemeIds: [],
  selectedByTheme: {},
  isolatedSignificantItems: [],
  p1p2Account: [],
} as unknown as RepresentativeEvidenceSelection;

const STOCKHOLM = "Уголовное дело о налоговом мошенничестве в Стокгольме";
const STOCKHOLM_QUOTE =
  "Anders Holmström, founder of Nordkap Capital, faces tax-fraud probe in Stockholm";

function verdict(over: Partial<LinkVerdict> & { evidenceRef: string }): LinkVerdict {
  return {
    schemaVersion: "link-verdict-v1",
    url: `https://affarsposten.se/${over.evidenceRef}`,
    domain: "affarsposten.se",
    subjectMatch: "subject",
    tone: "adverse",
    theme: STOCKHOLM,
    quotes: [],
    readAt: "2026-08-17T12:00:00.000Z",
    ...over,
  } as LinkVerdict;
}

function packFrom(themes: VerdictThemeSummary[], verdicts: LinkVerdict[]): ClientSummaryPack {
  return buildClientSummaryPack({
    caseId: "case-chain",
    datasetId: "ds-chain",
    subjectId: "Anders Holmström",
    sourceHashes: ["sha256:test"],
    claimsBundle: NO_CLAIMS,
    representative: NO_SELECTION,
    overallVerdict: "HIGH",
    linkVerdicts: { themes, verdicts },
  });
}

/** Сюжет из `pages` страниц: каждая со своим доменом. */
function widePlot(pages: number): { themes: VerdictThemeSummary[]; verdicts: LinkVerdict[] } {
  const refs = Array.from({ length: pages }, (_, i) => `inventory:obs-${i + 1}`);
  return {
    themes: [
      { theme: STOCKHOLM, count: pages, adverseCount: pages, evidenceRefs: refs, examples: [] },
    ],
    verdicts: refs.map((evidenceRef, i) =>
      verdict({
        evidenceRef,
        rank: i + 1,
        domain: i === 0 ? "affarsposten.se" : `nordic-review-${i}.se`,
        quotes: i === 0 ? [{ text: STOCKHOLM_QUOTE }] : [],
      })
    ),
  };
}

const SCOPED = {
  subject: { displayName: "Anders Holmström", aliases: [] },
  findings: [],
  surfaceUnits: [],
  metricSnapshot: {
    metricSnapshotId: "m",
    datasetId: "d",
    reportRunId: "r",
    baseCount: 20,
    enrichmentCount: 0,
    compositeCount: 20,
    subjectMatchCount: 12,
    likelySubjectCount: 1,
    ambiguousCount: 0,
    otherSubjectCount: 1,
    adverseFindingCount: 4,
    perRegionCounts: { RU: 10, UAE: 10 },
  },
  scope: fragmentScope("EXECUTIVE_SUMMARY"),
  evidenceIndex: {},
} as unknown as ScopedFragmentInput;

/** Слайды в форме рендерера — так их видит снимок клиентского текста. */
function clientTextOf(slides: ReturnType<typeof buildExecutiveSummaryFromComposed>["slides"]) {
  return extractClientText({
    slides: slides.map((s) => ({
      slideKey: s.slideId,
      title: s.title,
      subtitle: s.subtitle,
      narrative: s.content.narrative,
      bullets: s.content.bullets ?? [],
    })),
  });
}

describe("сюжет от вердикта до снимка клиентского текста", () => {
  it("заголовок сюжета виден в буллетах резюме", () => {
    const { themes, verdicts } = widePlot(3);
    const composed = composeClientSummary({ pack: packFrom(themes, verdicts) });
    const out = buildExecutiveSummaryFromComposed(
      "EXECUTIVE" as never,
      SCOPED,
      { composedClientSummary: composed } as never,
      composed
    );
    const snapshot = clientTextOf(out.slides);
    const bullets = snapshot.slides.flatMap((s) => s.bullets ?? []);
    expect(bullets.some((b) => b.startsWith(`${STOCKHOLM}.`))).toBe(true);
    expect(bullets.join(" ")).toContain(STOCKHOLM_QUOTE);
  });

  it("сюжет шире буллета делится на части и ничего не теряет", () => {
    const { themes, verdicts } = widePlot(40);
    const composed = composeClientSummary({ pack: packFrom(themes, verdicts) });
    const plan = paginateComposedClientSummary(composed, { leadThemeCount: 3 });
    expect(plan.gates.CLIENT_TEXT_TRUNCATIONS).toBe(0);
    expect(plan.gates.SUMMARY_BLOCK_OVER_BUDGET).toBe(0);
    const plotId = composed.sections.themes[0]!.themeId;
    const blocks = [...plan.overviewBlocks, ...plan.continuationPages.flat()].filter(
      (b) => b.themeId === plotId
    );
    expect(blocks.length).toBeGreaterThan(1);

    const out = buildExecutiveSummaryFromComposed(
      "EXECUTIVE" as never,
      SCOPED,
      { composedClientSummary: composed } as never,
      composed
    );
    const printed = clientTextOf(out.slides)
      .slides.flatMap((s) => s.bullets ?? [])
      .join(" ");
    // Ни один источник сюжета не пропал по дороге.
    for (let i = 1; i < 40; i += 1) {
      expect(printed).toContain(`nordic-review-${i}.se`);
    }
  });

  it("блок называет, сколько публикаций процитировано из скольких прочитанных", () => {
    /*
     * Молчаливый срез читается как «это всё, что нашли». На отчёте Прохорова
     * блок говорил «по сюжету прочитано 5 публикаций, 5 из них нежелательных»
     * и показывал две цитаты — владелец не смог понять, чем эти публикации
     * нежелательны и куда делись остальные.
     */
    const refs = Array.from({ length: 9 }, (_, i) => `inventory:obs-${i + 1}`);
    const themes: VerdictThemeSummary[] = [
      { theme: STOCKHOLM, count: 9, adverseCount: 9, evidenceRefs: refs, examples: [] },
    ];
    const verdicts = refs.map((evidenceRef, i) =>
      verdict({
        evidenceRef,
        rank: i + 1,
        domain: `nordic-review-${i + 1}.se`,
        quotes: [{ text: `Публикация номер ${i + 1} подробно разбирает обстоятельства дела и его последствия для деловой репутации` }],
      })
    );
    const composed = composeClientSummary({ pack: packFrom(themes, verdicts) });
    const body = composed.sections.themes[0]!.body;
    expect(body).toContain("Процитировано 6 публикаций сюжета из 9 прочитанных.");
  });

  it("когда процитированы все, лишней фразы нет", () => {
    const refs = Array.from({ length: 3 }, (_, i) => `inventory:obs-${i + 1}`);
    const themes: VerdictThemeSummary[] = [
      { theme: STOCKHOLM, count: 3, adverseCount: 3, evidenceRefs: refs, examples: [] },
    ];
    const verdicts = refs.map((evidenceRef, i) =>
      verdict({
        evidenceRef,
        rank: i + 1,
        domain: `nordic-review-${i + 1}.se`,
        quotes: [{ text: `Публикация номер ${i + 1} подробно разбирает обстоятельства дела и его последствия для деловой репутации` }],
      })
    );
    const composed = composeClientSummary({ pack: packFrom(themes, verdicts) });
    expect(composed.sections.themes[0]!.body).not.toMatch(/Процитирован/u);
  });
});
