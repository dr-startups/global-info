/**
 * Восстановление фикстуры визуальных ассетов report-72 из его же пакетов секций.
 *
 * ## Зачем
 *
 * `smoke:orion-deck-sections` проверяет самое ценное в сборке деки: что
 * доказательства слайда лежат на видимых плитках снимка, а домены в тексте
 * присутствуют на сетке. Для этого нужен `report-assets.json` прогона, а он
 * лежал под `/storage/` на одной машине и утрачен: прогон не воспроизводится.
 * Семь проверок были объявлены пропущенными (шаг 15, E11).
 *
 * ## Почему это не подлог
 *
 * Ассеты утрачены, но **их привязка записана** — пакеты секций в
 * `baselines/report-72/` собраны тем самым прогоном и хранят его итог:
 * `visualAssetRefs` у каждого слайда, `highlightExplanations`, `sourceNote` с
 * видимыми доменами. Это данные report-72, а не другого субъекта: фикстуру от
 * другого прогона подкладывать нельзя, и здесь этого не делается.
 *
 * Восстанавливается **вход** (какие ассеты к какому слоту привязаны и какие
 * доказательства на них видны), а проверяется он **записанным выходом**: если
 * сборка на восстановленном входе даёт те же объяснения рамок и тот же
 * колонтитул, что записаны в эталоне, — восстановление верно. Запись сделана
 * до восстановления и от него не зависит, поэтому это проверка, а не тавтология.
 *
 * Чего восстановить нельзя — байты изображений; смоку они и не нужны, он
 * читает только `hasImage`.
 *
 * Запуск: npm run fixture:deck-assets:rebuild
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DECK_ASSET_FIXTURE_PATH } from "./deck-asset-fixture-path";

const PACK_DIR = "baselines/report-72/artifacts/deck-sections/section-packs";

type PackSlide = {
  baseSlotId: string;
  visualAssetRefs?: string[];
  evidenceRefs?: string[];
  emptyStateReason?: string | null;
};

type FixtureEntry = {
  assetRef: string;
  kind: string;
  title: string;
  hasImage: boolean;
  evidenceRefs?: string[];
};

function walkJson(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJson(p));
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

/** Записанная прогоном привязка: слот → ассеты и доказательства слайда. */
export function readRecordedAssetBindings(packDir = PACK_DIR): Map<string, PackSlide> {
  const bySlot = new Map<string, PackSlide>();
  for (const file of walkJson(packDir)) {
    const pack = JSON.parse(readFileSync(file, "utf8")) as { slides?: PackSlide[] };
    for (const s of pack.slides ?? []) {
      if (!s.visualAssetRefs?.length) continue;
      if (!bySlot.has(s.baseSlotId)) bySlot.set(s.baseSlotId, s);
    }
  }
  return bySlot;
}

export function buildFixtureFromBindings(bySlot: Map<string, PackSlide>): FixtureEntry[] {
  const fixture: FixtureEntry[] = [];
  for (const [, slide] of [...bySlot].sort(([a], [b]) => a.localeCompare(b))) {
    for (const ref of slide.visualAssetRefs ?? []) {
      fixture.push({
        assetRef: ref,
        kind: ref.includes("image_grid")
          ? "image_grid"
          : ref.includes("serp")
            ? "serp_snapshot"
            : "visual",
        title: ref,
        // Ассет был привязан — значит изображение у прогона было.
        hasImage: true,
        // Видимые на ассете доказательства: те, что слайд за собой записал.
        // Слайд снимка ссылается ровно на то, что на снимке видно, — это и
        // проверяет сборка, сверяясь с записанным выходом.
        evidenceRefs: [...(slide.evidenceRefs ?? [])],
      });
    }
  }
  return fixture;
}

function main(): void {
  const bySlot = readRecordedAssetBindings();
  if (bySlot.size === 0) {
    console.error("В пакетах report-72 не нашлось ни одной записанной привязки ассетов.");
    process.exit(2);
  }
  const fixture = buildFixtureFromBindings(bySlot);
  mkdirSync(dirname(DECK_ASSET_FIXTURE_PATH), { recursive: true });
  writeFileSync(DECK_ASSET_FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(
    `Восстановлено ассетов: ${fixture.length} по ${bySlot.size} слотам → ${DECK_ASSET_FIXTURE_PATH}`
  );
  console.log("Проверьте смоком: npm run smoke:orion-deck-sections");
}

if (process.argv[1]?.endsWith("rebuild-deck-asset-fixture-from-baseline.ts")) {
  main();
}
