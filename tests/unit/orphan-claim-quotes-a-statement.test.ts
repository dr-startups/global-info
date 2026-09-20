/**
 * Сиротская претензия цитирует фразу, а не заголовок какой попало (шаг 0125).
 *
 * Резюме клиента строится из канонических утверждений. Утверждения по
 * материалам, которых не покрыла ни одна находка, собирает
 * `buildOrphanMaterialClaims`: он брал `entry.originalTitle` и оборачивал его
 * `sourceQuote` без единой проверки. На стр. 6 отчёта Абрамовича 20.09.2026 под
 * темой «Политические связи и публичная экспозиция» это дало
 * `«Абрамович Роман Аркадьевич» — источник (1sn.ru)`: голое имя вместо фразы.
 *
 * Страницы региона судят цитату `resolveExampleQuote`. Судья должен быть один:
 * заголовок цитируется, только если это целая фраза и не о другом человеке.
 */

import { describe, expect, it } from "vitest";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import {
  buildSubjectResolution,
  type SubjectIdentity,
} from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import { synthesizeFindings } from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { buildObservationDispositionLedger } from "@/modules/digital-profile/orion-golden/analytics/observation-disposition-ledger";
import { buildCanonicalClaimsBundle } from "@/modules/digital-profile/orion-golden/analytics/canonical-claim-builder";

const CASE = "case-orphan-quote";

const SUBJECT: SubjectIdentity = {
  displayName: "Абрамович Роман Аркадьевич",
  lastName: "Абрамович",
  lastNameVariants: ["abramovich"],
  firstNames: ["Роман", "roman"],
  patronymics: ["Аркадьевич"],
  aliases: ["Абрамович Роман Аркадьевич", "Roman Abramovich"],
  strongIdentifiers: ["770200186910"],
  contextIdentifiers: ["бизнесмен"],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
};

let seq = 0;
function item(partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `it-${seq}`,
    caseId: CASE,
    reportRunId: "base-run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-09-20T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: partial.snippet ?? "",
    sourceUrl: partial.sourceUrl ?? `https://news.example/${seq}`,
    ...partial,
  } as RawInventoryItem;
}

/**
 * Претензии по материалам, которых не покрыла ни одна находка.
 *
 * Реестр строится по настоящему синтезу — иначе у записей не было бы ни тем,
 * ни признаков существенности, — а в сборку утверждений уходит синтез без
 * находок: так каждая запись реестра становится сиротой, и путь сирот виден
 * тестом целиком.
 */
function orphanClaims(list: RawInventoryItem[]) {
  seq = 0;
  const resolution = buildSubjectResolution({
    caseId: CASE,
    datasetId: `ds-${CASE}`,
    subject: SUBJECT,
    items: list,
    sourceHashes: ["sha256:test"],
  });
  const byRef = new Map(
    resolution.items.map((i) => [
      i.evidenceRef,
      { ...i, decision: "SUBJECT_MATCH" as const, reasonCode: "forced:SUBJECT_MATCH" },
    ])
  );
  const synthesis = synthesizeFindings({
    caseId: CASE,
    datasetId: `ds-${CASE}`,
    items: list,
    resolutionByRef: byRef,
    sourceHashes: ["sha256:test"],
  });
  const dispositionLedger = buildObservationDispositionLedger({
    caseId: CASE,
    datasetId: `ds-${CASE}`,
    inventoryReportRunId: "base-run-1",
    sourceHashes: ["sha256:test"],
    items: list,
    resolutionByRef: byRef,
    synthesis,
  });
  const bundle = buildCanonicalClaimsBundle({
    caseId: CASE,
    datasetId: `ds-${CASE}`,
    subjectId: SUBJECT.displayName,
    sourceHashes: ["sha256:test"],
    items: list,
    synthesis: { ...synthesis, bundle: { ...synthesis.bundle, findings: [] }, ambiguousFindings: [] },
    dispositionLedger,
  });
  return bundle.claims;
}

describe("сиротская претензия цитирует целую фразу", () => {
  it("С1: голое имя в заголовке не становится цитатой", () => {
    const claims = orphanClaims([
      item({
        // Стр. 6 отчёта: профиль на 1sn.ru, заголовок — анкетное имя.
        title: "Абрамович Роман Аркадьевич",
        snippet:
          "Депутат Государственной думы по Чукотскому округу; суд рассматривал дело о хищении топлива.",
        sourceUrl: "https://1sn.ru/peoples/152",
      }),
    ]);
    const bodies = claims.map((c) => c.fullClaimText).join("\n");
    expect(bodies).not.toContain("«Абрамович Роман Аркадьевич»");
  });

  it("С3: без цитаты претензия называет источник — два обрубка подряд неразличимы", () => {
    // Стр. 7 отчёта Мордашова 20.09.2026: под «Репутационными скандалами»
    // дважды подряд напечатано «Отдельный заголовок с сутью риска в выдаче не
    // выделен — сверить первоисточники.» Строки одинаковы дословно, и читателю
    // нечего с ними делать: куда смотреть, они не говорят.
    const claims = orphanClaims([
      item({
        title: "Мордашов, Алексей",
        snippet: "Санкции ЕС и США против бизнесмена; суд отклонил иск об их отмене.",
        sourceUrl: "https://lenta.ru/lib/14164057",
      }),
    ]);
    const bodies = claims.map((c) => c.fullClaimText).join("\n");
    expect(bodies).toContain("Отдельный заголовок с сутью риска в выдаче не выделен");
    expect(bodies).toContain("lenta.ru");
  });

  it("С2: заголовок-фраза цитируется по-прежнему", () => {
    const claims = orphanClaims([
      item({
        title: "Суд ЕС в третий раз отказался снять санкции с Абрамовича",
        snippet: "Суд отклонил третий иск предпринимателя против санкционного режима ЕС.",
        sourceUrl: "https://tass.ru/politika/1",
      }),
    ]);
    const bodies = claims.map((c) => c.fullClaimText).join("\n");
    expect(bodies).toContain("«Суд ЕС в третий раз отказался снять санкции с Абрамовича»");
  });
});
