/**
 * Решения по прочитанным страницам доезжают до счёта негатива в аналитике.
 *
 * Предикат строки принимает вердикт параметром, и передать его обязан
 * конвейер: карта собирается один раз (`observationVerdictsForVisuals`) и
 * уходит обоим потребителям — разбору поверхностей и синтезу находок. Забыть
 * половину этой проводки нечем поймать иначе: офлайн чтение ссылок выключено,
 * и ни один эталон вердиктов не несёт — то есть на эталонах правка выглядела бы
 * сделанной и на живом прогоне не работала бы.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinkVerdict } from "@/modules/digital-profile/orion-golden/contracts/link-verdict";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import { boughtLinkVerdictsArtifact, linkVerdict } from "../fixtures/link-verdict-artifact";
import {
  TINY_ADVERSE_URL,
  TINY_CASE_ID,
  runTinyAnalytics,
  tinyInventory,
} from "../fixtures/tiny-canonical-prepare";

const FORBES_URL = "https://forbes.com/holmstrom";

function refFor(url: string): string {
  const item = tinyInventory().find((i) => i.sourceUrl === url)!;
  return `inventory:${item.inventoryId}`;
}

/** Каталог прогона; при непустом списке решений — с купленным артефактом. */
function dirWithVerdicts(verdicts: LinkVerdict[]): string {
  const dir = mkdtempSync(join(tmpdir(), "verdicts-reach-analytics-"));
  if (verdicts.length > 0) {
    writeFileSync(
      join(dir, "link-verdicts.json"),
      `${JSON.stringify(boughtLinkVerdictsArtifact({ caseId: TINY_CASE_ID, verdicts }), null, 2)}\n`,
      "utf8"
    );
  }
  return dir;
}

async function analytics(verdicts: LinkVerdict[], extraItems: RawInventoryItem[] = []) {
  const res = await runTinyAnalytics(dirWithVerdicts(verdicts), extraItems);
  const organic = res.surfaceAnalyses.organic.units[0]!;
  const metric = organic.metrics.find((m) => m.key === "adverseSubjectCount");
  const business = res.synthesis.bundle.findings.find((f) =>
    f.findingId.includes("business_profile")
  );
  return {
    adverseSubjectCount: Number(metric?.value ?? -1),
    businessProfileRisk: business?.riskLevel,
    newAdverseFindingCount: res.composite.providerDelta.newAdverseFindingCount,
  };
}

/** Второе наблюдение того же адреса: та же страница нашлась вторым запросом. */
function secondObservationOf(url: string): RawInventoryItem {
  const origin = tinyInventory().find((i) => i.sourceUrl === url)!;
  return {
    ...origin,
    inventoryId: `${origin.inventoryId}-q2`,
    query: "Anders Holmström Nordkap",
  };
}

/** Материал обогатителя: его считает прирост обогащения, а не поверхности. */
function arsenkinItem(): RawInventoryItem {
  const origin = tinyInventory().find((i) => i.sourceUrl === TINY_ADVERSE_URL)!;
  return {
    ...origin,
    inventoryId: "tiny-arsenkin-1",
    provider: "arsenkin",
    sourceUrl: "https://kapitalnytt.se/holmstrom-probe",
    title: "Anders Holmström of Nordkap Capital under criminal investigation",
    snippet: "Nordkap Capital founder Anders Holmström.",
    rawMetadata: { ...(origin.rawMetadata ?? {}), provider: "arsenkin", engine: "GOOGLE" },
  };
}

describe("вердикт прочитанной страницы доезжает до аналитики", () => {
  it("без решений корпус считается по словарю", async () => {
    const base = await analytics([]);
    expect(base.adverseSubjectCount).toBe(1);
    expect(base.businessProfileRisk).toBe("none");
  });

  it("благоприятная страница снимает негатив с метрики поверхности", async () => {
    const supportive = await analytics([
      linkVerdict({
        evidenceRef: refFor(TINY_ADVERSE_URL),
        url: TINY_ADVERSE_URL,
        tone: "supportive",
        theme: "Деловой профиль предпринимателя",
      }),
    ]);
    expect(supportive.adverseSubjectCount).toBe(0);
  });

  it("второе наблюдение того же адреса решение получает вместе с первым", async () => {
    const second = secondObservationOf(TINY_ADVERSE_URL);
    const base = await analytics([], [second]);
    expect(base.adverseSubjectCount).toBe(2);

    const supportive = await analytics(
      [
        linkVerdict({
          evidenceRef: refFor(TINY_ADVERSE_URL),
          url: TINY_ADVERSE_URL,
          tone: "supportive",
          theme: "Деловой профиль предпринимателя",
        }),
      ],
      [second]
    );
    expect(supportive.adverseSubjectCount).toBe(0);
  });

  it("прирост обогащения считает негатив тем же ответом", async () => {
    const enrichment = arsenkinItem();
    const base = await analytics([], [enrichment]);
    expect(base.newAdverseFindingCount).toBe(1);

    const supportive = await analytics(
      [
        linkVerdict({
          evidenceRef: `inventory:${enrichment.inventoryId}`,
          url: enrichment.sourceUrl!,
          domain: "kapitalnytt.se",
          tone: "supportive",
          theme: "Деловой профиль предпринимателя",
        }),
      ],
      [enrichment]
    );
    expect(supportive.newAdverseFindingCount).toBe(0);
  });

  it("нежелательная страница с цитатой поднимает уровень темы", async () => {
    const adverse = await analytics([
      linkVerdict({
        evidenceRef: refFor(FORBES_URL),
        url: FORBES_URL,
        domain: "forbes.com",
        rank: 2,
        tone: "adverse",
        theme: "Налоговое разбирательство в Стокгольме",
      }),
    ]);
    expect(adverse.businessProfileRisk).toBe("low");
  });
});
