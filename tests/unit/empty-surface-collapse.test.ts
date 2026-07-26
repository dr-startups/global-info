import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collapseEmptySurfaceSlots,
  emptySurfaceMergeReason,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/empty-surface-collapse";

/**
 * Шаг 15, E2.
 *
 * Страницы 31–33 «Россия — связанные запросы (1..3)» были дословно одинаковы:
 * «Поверхность не собиралась в этом прогоне». Тот же дефект был с четырьмя
 * страницами «изображения» в шаге 13. Построитель отдавал слайд на каждый
 * канонический слот независимо от наличия данных.
 *
 * Три одинаковые страницы не сообщают втрое больше — они сообщают то же самое.
 */

const empty = (id: string) => ({ baseSlotId: id, emptyStateReason: "no-related" });
const filled = (id: string) => ({ baseSlotId: id });

describe("пустая поверхность занимает одну страницу", () => {
  it("три пустые страницы сворачиваются в первую", () => {
    const r = collapseEmptySurfaceSlots([
      empty("p20_ru_related_1"),
      empty("p21_ru_related_2"),
      empty("p22_ru_related_3"),
    ]);
    expect(r.slides.map((s) => s.baseSlotId)).toEqual(["p20_ru_related_1"]);
    expect(r.mergedSlots.map((m) => m.baseSlotId)).toEqual([
      "p21_ru_related_2",
      "p22_ru_related_3",
    ]);
  });

  it("слот не теряется: у слияния есть адресат и причина", () => {
    // Покрытие остаётся полным, и сверка отвечает за каждую позицию.
    const r = collapseEmptySurfaceSlots([empty("a"), empty("b")]);
    expect(r.mergedSlots[0]).toMatchObject({ baseSlotId: "b", mergedInto: "a" });
    expect(r.mergedSlots[0]!.reason).toMatch(/статус приведён один раз/iu);
  });

  it("содержательные страницы не трогаются", () => {
    // Разбиение материала по страницам — не дубль.
    const slides = [filled("a"), filled("b"), filled("c")];
    const r = collapseEmptySurfaceSlots(slides);
    expect(r.slides).toHaveLength(3);
    expect(r.mergedSlots).toEqual([]);
  });

  it("частично пустой фрагмент не сворачивается", () => {
    // Если хоть одна страница содержательна, остальные показывают свой статус
    // на своём месте — иначе читатель не поймёт, к чему относится пустота.
    const r = collapseEmptySurfaceSlots([filled("a"), empty("b"), empty("c")]);
    expect(r.slides).toHaveLength(3);
    expect(r.mergedSlots).toEqual([]);
  });

  it("один слот сворачивать не во что", () => {
    const r = collapseEmptySurfaceSlots([empty("a")]);
    expect(r.slides).toHaveLength(1);
    expect(r.mergedSlots).toEqual([]);
  });

  it("пустой список не роняет", () => {
    expect(collapseEmptySurfaceSlots([])).toEqual({ slides: [], mergedSlots: [] });
  });

  it("слот, слитый статическим правилом, второй раз не сливается", () => {
    // Два адресата у одного слота — противоречие, а не полнота. На прогоне
    // p36_lexis_visual_2 получил сразу два слияния: статическое и выведенное.
    const src = readFileSync(
      join(process.cwd(), "src/modules/digital-profile/orion-golden/deck-sections/deck-assembler.ts"),
      "utf8"
    );
    expect(src).toMatch(/staticallyMerged\.has\(slot\.slotId\)/u);
  });

  it("причина объясняет читателю, а не ссылается на код", () => {
    expect(emptySurfaceMergeReason()).not.toMatch(/[A-Z]{3,}_[A-Z]/u);
    expect(emptySurfaceMergeReason()).toMatch(/поверхность/iu);
  });
});

/**
 * Шаг 15, E2 — покрытие слотов считается по манифесту, а не по статическому
 * списку. Две реализации одного вопроса разошлись: сборщик знал о выведенных
 * слияниях, а гейт подготовки — нет, и пересборка падала с
 * «baseSlotCoverage != 36; missing canonical slots: p21_ru_related_2,
 * p22_ru_related_3».
 */
describe("покрытие слотов имеет один источник правды", () => {
  it("гейт подготовки читает слияния из манифеста", () => {
    const src = readFileSync(
      join(process.cwd(), "src/modules/digital-profile/services/canonical-report-prepare.ts"),
      "utf8"
    );
    expect(src).toMatch(/deckManifest\.mergedSlots \?\? \[\]/u);
    // Статический список больше не источник правды о покрытии.
    expect(src).not.toMatch(/\.\.\.MERGED_SLOT_IDS/u);
  });
});
