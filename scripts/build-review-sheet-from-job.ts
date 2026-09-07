/**
 * Лист проверки настоящего прогона — офлайн, из каталога джобы.
 *
 * Вход — каталог, снятый с тома или распакованный из диагностического бандла
 * (`analytics/`, `deck/assembled-deck.json`, `visual-assets-by-slot.json`).
 * В репозиторий такие каталоги не идут: там материалы по делам живых людей.
 *
 *   npx tsx scripts/build-review-sheet-from-job.ts <каталог-джобы> [--out <файл>]
 *
 * Печатает сводку словами: сколько пунктов, сколько открытых, сколько
 * материалов обведено рамкой при неподтверждённой принадлежности. Ни сети, ни
 * базы, ни платных вызовов здесь нет.
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildReviewSheetFromJobDir } from "../src/modules/digital-profile/services/review-sheet-artifact";

function main(): number {
  const args = process.argv.slice(2);
  const jobDir = resolve(args[0] ?? "");
  if (!args[0] || !existsSync(jobDir)) {
    console.error("Укажите каталог джобы: npx tsx scripts/build-review-sheet-from-job.ts <каталог>");
    return 1;
  }
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;

  const sheet = buildReviewSheetFromJobDir({ caseId: "(из каталога)", artifactsDir: jobDir });
  const framedUnconfirmed = sheet.items.filter(
    (i) => i.kind === "evidence" && i.framedAs && i.open
  ).length;

  console.log(`[лист проверки] материалов ${sheet.summary.evidence.total}, из них открытых ${sheet.summary.evidence.open}`);
  console.log(`[лист проверки] в красной рамке ${sheet.summary.evidence.framed}, из них с неподтверждённой принадлежностью ${framedUnconfirmed}`);
  console.log(`[лист проверки] тем ${sheet.summary.finding.total}, из них требуют подтверждения ${sheet.summary.finding.open}`);
  console.log(`[лист проверки] пунктов комплаенса ${sheet.summary.compliance.total}, из них открытых ${sheet.summary.compliance.open}`);

  if (outPath) {
    writeFileSync(resolve(outPath), `${JSON.stringify(sheet, null, 2)}\n`, "utf8");
    console.log(`[лист проверки] записан: ${resolve(outPath)}`);
  }
  return 0;
}

process.exitCode = main();
