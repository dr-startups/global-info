/**
 * Купленный артефакт чтения ссылок: то, что остаётся на диске после прогона,
 * заплатившего за страницы и вердикты. Общая фикстура — потому что и реюз, и
 * объявление потери проверяются на одном и том же содержимом.
 */

import {
  LINK_VERDICT_SCHEMA_VERSION,
  summarizeLinkVerdicts,
  type LinkVerdict,
} from "@/modules/digital-profile/orion-golden/contracts/link-verdict";

export function linkVerdict(over: Partial<LinkVerdict> = {}): LinkVerdict {
  return {
    schemaVersion: LINK_VERDICT_SCHEMA_VERSION,
    evidenceRef: "inventory:obs-a1",
    url: "https://di.se/holmstrom-tax",
    domain: "di.se",
    rank: 1,
    query: "Anders Holmström",
    region: "RU",
    subjectMatch: "subject",
    tone: "adverse",
    theme: "Налоговое разбирательство в Стокгольме",
    quotes: [
      {
        text: "Прокуратура Стокгольма ведёт разбирательство о неуплате налогов компанией Nordkap Capital.",
      },
    ],
    readAt: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

/** Артефакт прогона, в котором страницы прочитаны и решения вынесены. */
export function boughtLinkVerdictsArtifact(input: {
  caseId: string;
  verdicts: LinkVerdict[];
  schemaVersion?: string;
  datasetId?: string;
}): Record<string, unknown> {
  const summary = summarizeLinkVerdicts(input.verdicts);
  const n = input.verdicts.length;
  return {
    schemaVersion: input.schemaVersion ?? LINK_VERDICT_SCHEMA_VERSION,
    caseId: input.caseId,
    requested: n,
    readOk: n,
    reading: { status: "OK", requested: n, read: n, failed: 0, retried: 0, byReason: {} },
    audit: { checked: n, quotesDropped: 0, adverseDowngraded: 0, subjectDowngraded: 0, changes: [] },
    themesByRegion: { RU: summary.themes },
    readingBroken: false,
    verdicts: input.verdicts,
    summary,
    datasetId: input.datasetId ?? "composite-previous",
  };
}
