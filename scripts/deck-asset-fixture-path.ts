import { join } from "node:path";

/**
 * Обезличенная фикстура визуальных ассетов канареечного прогона.
 *
 * Лежит рядом с остальными базовыми артефактами report-72: это метаданные без
 * байтов изображений, поэтому коммитить их можно, в отличие от исходного
 * `report-assets.json` под `/storage/`.
 */
export const DECK_ASSET_FIXTURE_PATH = join(
  process.cwd(),
  "baselines",
  "report-72",
  "artifacts",
  "deck-sections",
  "report-assets.fixture.json"
);

/** Сообщение, объясняющее, что делать, когда фикстуры нет. */
export const DECK_ASSET_FIXTURE_MISSING = [
  "Фикстура визуальных ассетов отсутствует.",
  `Ожидается: ${DECK_ASSET_FIXTURE_PATH}`,
  "Она обезличена (метаданные без байтов изображений) и создаётся из прогона:",
  "  npm run fixture:deck-assets -- storage/digital-profile/<case>/<run>/report-assets.json",
].join("\n");
