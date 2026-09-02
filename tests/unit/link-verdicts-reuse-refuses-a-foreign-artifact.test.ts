/**
 * Купленное чтение переиспользуется только тогда, когда это действительно оно.
 *
 * Вердикты — единственный артефакт отчёта, у которого нет базы: страницы
 * прочитаны и оплачены один раз, восстановить их неоткуда. Поэтому пересборка
 * их переиспользует, а не покупает заново, — и ровно поэтому переиспользование
 * обязано быть узким: чужой кейс, чужая версия схемы и неразобранный файл
 * реюзом не являются. Тихо подсунуть в отчёт мусор хуже, чем перечитать.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReusableLinkVerdicts } from "@/modules/digital-profile/orion-golden/analytics/run-link-verdicts";
import type { LinkVerdict } from "@/modules/digital-profile/orion-golden/contracts/link-verdict";
import {
  boughtLinkVerdictsArtifact,
  linkVerdict,
} from "../fixtures/link-verdict-artifact";

function dirWith(artifact: unknown | null): string {
  const dir = mkdtempSync(join(tmpdir(), "link-verdict-reuse-"));
  if (artifact !== null) {
    writeFileSync(
      join(dir, "link-verdicts.json"),
      typeof artifact === "string" ? artifact : `${JSON.stringify(artifact, null, 2)}\n`,
      "utf8"
    );
  }
  return dir;
}

const CASE = "case-tiny-prepare";

describe("переиспользование купленных вердиктов", () => {
  it("артефакт своего кейса с вердиктами переиспользуется целиком", () => {
    const verdicts = [linkVerdict(), linkVerdict({ evidenceRef: "inventory:obs-a2", rank: 2 })];
    const dir = dirWith(boughtLinkVerdictsArtifact({ caseId: CASE, verdicts }));

    const reuse = loadReusableLinkVerdicts(dir, { caseId: CASE });

    expect(reuse.status).toBe("reuse");
    if (reuse.status !== "reuse") return;
    expect(reuse.result.verdicts).toEqual(verdicts);
    expect(reuse.result.summary.themes[0]!.theme).toBe("Налоговое разбирательство в Стокгольме");
    expect(reuse.result.themesByRegion.RU).toBeTruthy();
    expect(reuse.previousDatasetId).toBe("composite-previous");
    // «Шаг пропущен» и «результат куплен раньше» — разные вещи, и одно поле не
    // может значить обе.
    expect(reuse.result.skippedReason).toBeUndefined();
  });

  it("прогон со сломанным чтением тоже куплен: он замораживается, а не затирается", () => {
    const verdicts = [
      linkVerdict({ readFailure: "blocked", tone: "neutral", quotes: [] }),
      linkVerdict({
        evidenceRef: "inventory:obs-a2",
        readFailure: "timeout",
        tone: "neutral",
        quotes: [],
      }),
    ];
    const artifact = boughtLinkVerdictsArtifact({ caseId: CASE, verdicts });
    artifact.readOk = 0;
    artifact.readingBroken = true;

    const reuse = loadReusableLinkVerdicts(dirWith(artifact), { caseId: CASE });

    expect(reuse.status).toBe("reuse");
    if (reuse.status !== "reuse") return;
    expect(reuse.result.readingBroken).toBe(true);
  });

  it("артефакта нет — переиспользовать нечего и терять нечего", () => {
    expect(loadReusableLinkVerdicts(dirWith(null), { caseId: CASE }).status).toBe("none");
  });

  it("пустой артефакт прошлого прогона реюзом не является и потерей тоже", () => {
    const dir = dirWith(boughtLinkVerdictsArtifact({ caseId: CASE, verdicts: [] }));
    // Следующую попытку решает флаг — ровно как сегодня.
    expect(loadReusableLinkVerdicts(dir, { caseId: CASE }).status).toBe("none");
  });

  it("чужой кейс не переиспользуется: каталог мог быть скопирован", () => {
    const dir = dirWith(
      boughtLinkVerdictsArtifact({ caseId: "case-somebody-else", verdicts: [linkVerdict()] })
    );

    const reuse = loadReusableLinkVerdicts(dir, { caseId: CASE });

    expect(reuse.status).toBe("lost");
    if (reuse.status !== "lost") return;
    expect(reuse.reason).toBe("foreign-case");
    expect(reuse.previousVerdictCount).toBe(1);
  });

  it("чужая версия схемы не скармливается потребителям, которые её не знают", () => {
    const dir = dirWith(
      boughtLinkVerdictsArtifact({
        caseId: CASE,
        verdicts: [linkVerdict(), linkVerdict()],
        schemaVersion: "link-verdict-v0",
      })
    );

    const reuse = loadReusableLinkVerdicts(dir, { caseId: CASE });

    expect(reuse.status).toBe("lost");
    if (reuse.status !== "lost") return;
    expect(reuse.reason).toBe("schema-mismatch");
    expect(reuse.previousVerdictCount).toBe(2);
  });

  it("пустой на вид артефакт чужой схемы — это чужая схема, а не пустота", () => {
    // Решения будущей схемы могут лежать под другим ключом: считать такой файл
    // пустым значило бы затереть купленное молча.
    const dir = dirWith(
      boughtLinkVerdictsArtifact({ caseId: CASE, verdicts: [], schemaVersion: "link-verdict-v2" })
    );

    const reuse = loadReusableLinkVerdicts(dir, { caseId: CASE });

    expect(reuse.status).toBe("lost");
    if (reuse.status !== "lost") return;
    expect(reuse.reason).toBe("schema-mismatch");
  });

  it("вердикт, не прошедший разбор, делает артефакт непереиспользуемым", () => {
    const broken = boughtLinkVerdictsArtifact({ caseId: CASE, verdicts: [linkVerdict()] });
    (broken.verdicts as LinkVerdict[])[0]!.tone = "восторженный" as LinkVerdict["tone"];

    const reuse = loadReusableLinkVerdicts(dirWith(broken), { caseId: CASE });

    expect(reuse.status).toBe("lost");
    if (reuse.status !== "lost") return;
    expect(reuse.reason).toBe("invalid");
  });

  it("нечитаемый файл — потеря с названной причиной, а не тихая пустота", () => {
    const reuse = loadReusableLinkVerdicts(dirWith("{ это не json"), { caseId: CASE });

    expect(reuse.status).toBe("lost");
    if (reuse.status !== "lost") return;
    expect(reuse.reason).toBe("unreadable");
    // Сколько вердиктов было — из такого файла не узнать, и врать числом нельзя.
    expect(reuse.previousVerdictCount).toBe(0);
  });
});
