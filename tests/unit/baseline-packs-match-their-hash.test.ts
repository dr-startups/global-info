/**
 * Пакеты эталона произведены теми построителями, чьими они себя называют.
 *
 * `contentHash` пакета считается по `JSON.stringify(slides)` — то есть зависит
 * и от порядка ключей. Кэш секций отдаёт пакет, прочитанный через zod (порядок
 * ключей схемы), а `runDeckBuild` пишет его обратно, сохранив прежний хэш: у
 * прогона, взявшего секции из кэша, закоммиченные байты перестают
 * соответствовать объявленному хэшу. Эталон, снятый с такого прогона, выглядит
 * целым, но произведён не тем, что лежит в `fragment-builders/`.
 *
 * Лечится тем же, чем ловится: перед пересборкой эталона удалить
 * `section-packs/` и прогнать скрипт один раз.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FRAGMENT_ARTIFACT_PATHS } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const PACKS_ROOT = join(process.cwd(), "baselines", "report-72", "artifacts", "deck-sections");

describe("эталонные пакеты секций", () => {
  it("совпадают со своим contentHash", () => {
    const mismatched: string[] = [];
    for (const rel of Object.values(FRAGMENT_ARTIFACT_PATHS)) {
      const pack = JSON.parse(readFileSync(join(PACKS_ROOT, rel), "utf8")) as {
        contentHash: string;
        slides: unknown[];
      };
      const actual = `sha256:${createHash("sha256")
        .update(JSON.stringify(pack.slides))
        .digest("hex")}`;
      if (actual !== pack.contentHash) mismatched.push(rel);
    }
    expect(
      mismatched,
      [
        "Пакеты эталона не соответствуют своему contentHash — значит, эталон снят",
        "с прогона, взявшего секции из кэша, а не собравшего их заново.",
        "",
        "  rm -rf baselines/report-72/artifacts/deck-sections/section-packs",
        "  npx tsx scripts/run-orion-deck-sections-report72.ts",
      ].join("\n")
    ).toEqual([]);
  });
});
