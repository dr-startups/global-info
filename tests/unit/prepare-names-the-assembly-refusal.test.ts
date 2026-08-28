import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CanonicalPrepareBlockedError,
  prepareBlockedErrorFor,
} from "@/modules/digital-profile/services/canonical-report-prepare";
import {
  BulletFitNotConvergedError,
  NarrativeOverBudgetError,
  NarrativeReflowLossError,
} from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import { runCanonicalReportPrepare } from "@/modules/digital-profile/services/canonical-report-prepare";
import { tinyPrepareInput } from "../fixtures/tiny-canonical-prepare";

/**
 * Отказ сборки называется кодом, по которому восстановление знает, что делать.
 *
 * Безымянная ошибка не подходит ни под один пункт классификатора: на последнем
 * шаге **оплаченного** прогона она выглядит аварией, хотя данные сбора целы, а
 * дефект детерминированный и повтором не лечится. Отображение при этом легко
 * снять и не заметить: пока оно стояло двумя вкладышами в `catch`, его удаление
 * оставляло `npm run ci` зелёным.
 */

const PREPARE = join(
  process.cwd(),
  "src/modules/digital-profile/services/canonical-report-prepare.ts"
);

describe("отказ сборки переводится в код, который понимает восстановление", () => {
  it("несошедшийся цикл меры — потеря содержимого", () => {
    const blocked = prepareBlockedErrorFor(
      new BulletFitNotConvergedError("страница 7", { outcome: "NOT_CONVERGED" } as never)
    );
    expect(blocked?.code).toBe("CONTENT_DROPPED_BY_RENDERER");
  });

  it.each([
    [
      "абзац не влезает в лист",
      new NarrativeOverBudgetError([
        { slideKey: "p03_persona", templateId: "persona-check", length: 1200, budget: 1113 },
      ]),
    ],
    [
      "резак выбросил часть абзаца",
      new NarrativeReflowLossError([{ slideKey: "p03_persona", before: 403, after: 344 }]),
    ],
  ])("%s — качество текста сборки", (_what, err) => {
    const blocked = prepareBlockedErrorFor(err);
    expect(blocked).toBeInstanceOf(CanonicalPrepareBlockedError);
    // Данные сбора целы, платить заново не за что: тот же код, что у остальных
    // отказов качества сборки, — восстановление предложит пересборку.
    expect(blocked?.code).toBe("ASSEMBLY_QA_FAILED");
    expect(blocked?.message).toContain("p03_persona");
  });

  it("чужая ошибка не присваивается", () => {
    expect(prepareBlockedErrorFor(new Error("boom"))).toBeNull();
    expect(prepareBlockedErrorFor("не ошибка вовсе")).toBeNull();
  });
});

describe("оба выхода из сборки спрашивают этот перевод", () => {
  it("и мерный путь, и путь рендера", () => {
    /*
     * Проверка смотрит в исходник намеренно. Отображение — две строки в разных
     * `catch`, и удаление любой из них поведение остальных проверок не меняет:
     * ревьюер снял обе, и 381 файл тестов остался зелёным. Значит, держать их
     * может только счёт мест, где перевод спрашивают.
     *
     * Предел у неё прямой: «вкладыш удалён, а вызов дописан в другом месте» она
     * пропустит — считает вхождения, а не выходы. Поведенчески закрыт путь
     * рендера (проверка ниже); мерный путь остаётся за ней одной.
     */
    const source = readFileSync(PREPARE, "utf8");
    const calls = source.match(/prepareBlockedErrorFor\(/gu) ?? [];
    // Одно вхождение — объявление функции, остальные — места применения.
    expect(calls.length, "перевод отказа должен спрашиваться на обоих выходах").toBeGreaterThanOrEqual(3);
  });

  it("на пути рендера отказ доходит кодом сборки, а не сбоем рендерера", async () => {
    /*
     * Здесь проверка поведенческая, а не структурная: рендерер инъектируется,
     * и прогон без меры собирает нагрузку впервые внутри него. Со снятым
     * вкладышем отказ приезжает как `RENDER_FAILED` — то есть восстановление
     * предложит повтор там, где повтор не лечит.
     */
    const root = mkdtempSync(join(tmpdir(), "prepare-refusal-render-"));
    const err = await runCanonicalReportPrepare(
      await tinyPrepareInput(root, {
        render: () => {
          throw new NarrativeReflowLossError([
            { slideKey: "p03_persona", before: 403, after: 344 },
          ]);
        },
      })
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(CanonicalPrepareBlockedError);
    expect((err as CanonicalPrepareBlockedError).code).toBe("ASSEMBLY_QA_FAILED");
  });
});
