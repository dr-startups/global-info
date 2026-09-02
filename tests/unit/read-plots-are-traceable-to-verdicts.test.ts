/**
 * Сюжет резюме сводится к наблюдениям — или отчёт не собирается.
 *
 * Резюме перестало называть рубрики словаря и называет сюжеты прочитанных
 * страниц. Сюжет — это утверждение о субъекте, и правило проекта на него
 * распространяется целиком: каждое утверждение прослеживается до наблюдения с
 * URL и доменом. Здесь закреплён единственный способ, которым эта связь
 * проверяется машиной, — ссылки участников на строке темы.
 *
 * Ловится именно отсутствие связи, а не отсутствие строки: сюжет с красивым
 * названием, за которым нет ни одного вердикта, обязан валить ворота пакета, а
 * сюжет без ссылок — ворота композера.
 */

import { describe, expect, it } from "vitest";
import {
  assertClientSummaryPackGatesPass,
  buildClientSummaryPack,
} from "@/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import {
  assertComposedSummaryGatesPass,
  composeClientSummary,
} from "@/modules/digital-profile/orion-golden/analytics/client-summary-composer";
import type { CanonicalClaimsBundle } from "@/modules/digital-profile/orion-golden/contracts/canonical-claim";
import type { ClientSummaryPack } from "@/modules/digital-profile/orion-golden/contracts/client-summary-pack";
import type {
  LinkVerdict,
  VerdictThemeSummary,
} from "@/modules/digital-profile/orion-golden/contracts/link-verdict";
import type { RepresentativeEvidenceSelection } from "@/modules/digital-profile/orion-golden/contracts/representative-evidence";

/** Пакет строится без претензий: проверяется только ветка сюжетов. */
const NO_CLAIMS = { claims: [] } as unknown as CanonicalClaimsBundle;
const NO_SELECTION = {
  materialThemeIds: [],
  selectedByTheme: {},
  isolatedSignificantItems: [],
  p1p2Account: [],
} as unknown as RepresentativeEvidenceSelection;

function readVerdict(
  evidenceRef: string,
  over: Partial<LinkVerdict> = {}
): LinkVerdict {
  return {
    schemaVersion: "link-verdict-v1",
    evidenceRef,
    url: `https://affarsposten.se/${evidenceRef}`,
    domain: "affarsposten.se",
    rank: 1,
    subjectMatch: "subject",
    tone: "adverse",
    theme: "Уголовное дело о налоговом мошенничестве в Стокгольме",
    quotes: [
      {
        text: "Anders Holmström, founder of Nordkap Capital, faces tax-fraud probe in Stockholm",
      },
    ],
    readAt: "2026-08-17T12:00:00.000Z",
    ...over,
  } as LinkVerdict;
}

function themeRow(over: Partial<VerdictThemeSummary> = {}): VerdictThemeSummary {
  return {
    theme: "Уголовное дело о налоговом мошенничестве в Стокгольме",
    count: 1,
    adverseCount: 1,
    evidenceRefs: ["inventory:obs-01"],
    examples: [],
    ...over,
  };
}

function packWith(
  themes: VerdictThemeSummary[],
  verdicts: LinkVerdict[]
): ClientSummaryPack {
  return buildClientSummaryPack({
    caseId: "case-plots",
    datasetId: "ds-plots",
    subjectId: "Anders Holmström",
    sourceHashes: ["sha256:test"],
    claimsBundle: NO_CLAIMS,
    representative: NO_SELECTION,
    overallVerdict: "HIGH",
    linkVerdicts: { themes, verdicts },
  });
}

describe("сюжет пакета прослеживается до вердикта", () => {
  it("сюжет из строки артефакта несёт ссылки своих страниц", () => {
    const pack = packWith(
      [themeRow({ count: 2, evidenceRefs: ["inventory:obs-01", "inventory:obs-02"] })],
      [readVerdict("inventory:obs-01"), readVerdict("inventory:obs-02", { rank: 4 })]
    );
    expect(pack.readPlots).toHaveLength(1);
    expect(pack.readPlots[0]!.evidenceRefs).toEqual([
      "inventory:obs-01",
      "inventory:obs-02",
    ]);
    expect(pack.readPlots[0]!.title).toBe(
      "Уголовное дело о налоговом мошенничестве в Стокгольме"
    );
    expect(pack.gates.READ_PLOTS_WITHOUT_EVIDENCE).toBe(0);
    expect(() => assertClientSummaryPackGatesPass(pack)).not.toThrow();
  });

  it("выдуманный сюжет валит ворота пакета", () => {
    const pack = packWith(
      [
        themeRow(),
        // Название есть, состава нет — сводить сюжет не к чему.
        themeRow({ theme: "Хищение средств фонда развития", evidenceRefs: [] }),
        // Ссылка есть, но такого вердикта в прогоне не было.
        themeRow({
          theme: "Связи с подсанкционным банком",
          evidenceRefs: ["inventory:obs-ghost"],
        }),
      ],
      [readVerdict("inventory:obs-01")]
    );
    expect(pack.gates.READ_PLOTS_WITHOUT_EVIDENCE).toBe(2);
    expect(pack.gates.CLIENT_SUMMARY_PACK_VALID).toBe(false);
    expect(() => assertClientSummaryPackGatesPass(pack)).toThrow(
      /READ_PLOTS_WITHOUT_EVIDENCE/
    );
  });

  it("страница другого человека сюжет не подтверждает", () => {
    const pack = packWith(
      [themeRow({ evidenceRefs: ["inventory:obs-other"] })],
      [
        readVerdict("inventory:obs-01"),
        readVerdict("inventory:obs-other", { subjectMatch: "other" }),
      ]
    );
    expect(pack.readPlots[0]!.quotes).toEqual([]);
    expect(pack.readPlots[0]!.sourceDomains).toEqual([]);
  });

  it("сюжет без ссылок валит ворота композера", () => {
    const pack = packWith([themeRow()], [readVerdict("inventory:obs-01")]);
    const forged: ClientSummaryPack = {
      ...pack,
      readPlots: [{ ...pack.readPlots[0]!, evidenceRefs: [] }],
    };
    const summary = composeClientSummary({ pack: forged });
    expect(summary.gates.SUMMARY_UNSUPPORTED_ASSERTIONS).toBeGreaterThan(0);
    expect(() => assertComposedSummaryGatesPass(summary)).toThrow(
      /SUMMARY_UNSUPPORTED_ASSERTIONS/
    );
  });
});
