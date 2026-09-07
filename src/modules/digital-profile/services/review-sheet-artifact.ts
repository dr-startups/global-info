/**
 * Лист проверки на диске: чем он собирается и где лежит.
 *
 * Построитель листа чист и офлайновый (`review-sheet.ts`), а читать артефакты
 * джобы умеет этот модуль — и он один. Им пользуются оба вызывающих: подготовка
 * отчёта, которая пишет лист после сборки деки, и офлайновый скрипт разбора
 * прогона. Второй ответ на «из чего собран лист» разошёлся бы с первым ровно
 * тогда, когда лист понадобится для разбора настоящего отказа.
 *
 * Лист живёт рядом с декой (`deck/review-sheet.json`), а не в аналитике:
 * собран он из **напечатанного**, и аналитика на момент своего прогона о
 * страницах ещё ничего не знает.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REVIEW_SHEET_ARTIFACT,
  buildReviewSheet,
  type ReviewSheet,
  type ReviewSheetComplianceItem,
  type ReviewSheetFinding,
  type ReviewSheetObservation,
  type ReviewSheetResolution,
  type ReviewSheetSlide,
  type ReviewSheetVisualAsset,
} from "./review-sheet";

/** Где лежит лист проверки джобы. */
export function reviewSheetPath(artifactsDir: string): string {
  return join(artifactsDir, "deck", REVIEW_SHEET_ARTIFACT);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // Битый артефакт — не повод ронять подготовку отчёта: лист просто не
    // получит этой части, и его пустой раздел скажет об этом сам.
    return null;
  }
}

/**
 * Собрать лист проверки из артефактов джобы.
 *
 * Слайды принимаются параметром, когда дека уже в памяти (подготовка отчёта
 * знает её и на пути возобновления), и читаются с диска, когда нет (разбор
 * готового прогона).
 */
export function buildReviewSheetFromJobDir(input: {
  caseId: string;
  artifactsDir: string;
  slides?: readonly ReviewSheetSlide[];
}): ReviewSheet {
  const analyticsDir = join(input.artifactsDir, "analytics");
  const slides =
    input.slides ??
    readJson<{ slides?: ReviewSheetSlide[] }>(
      join(input.artifactsDir, "deck", "assembled-deck.json")
    )?.slides ??
    [];

  const observations =
    readJson<{ observations?: ReviewSheetObservation[] }>(
      join(analyticsDir, "composite-serp-observations.json")
    )?.observations ?? [];

  const subjectResolution =
    readJson<{ items?: ReviewSheetResolution[] }>(join(analyticsDir, "subject-resolution.json"))
      ?.items ?? [];

  const visualAssets =
    readJson<{ visualAssets?: Record<string, ReviewSheetVisualAsset[]> }>(
      join(input.artifactsDir, "visual-assets-by-slot.json")
    )?.visualAssets ?? {};

  const bundle = readJson<{ findings?: ReviewSheetFinding[] }>(
    join(analyticsDir, "verified-finding-bundle.json")
  );
  const ambiguousFindings =
    readJson<ReviewSheetFinding[]>(join(analyticsDir, "ambiguous-findings.json")) ?? [];

  const compliance = readJson<{ items?: ReviewSheetComplianceItem[] }>(
    join(analyticsDir, "compliance-inventory.json")
  );

  return buildReviewSheet({
    caseId: input.caseId,
    slides,
    observations,
    subjectResolution,
    visualAssets,
    findings: bundle?.findings ?? [],
    ambiguousFindings,
    compliance,
  });
}

/** Собрать лист и положить его рядом с декой. Возвращает путь. */
export function writeReviewSheet(input: {
  caseId: string;
  artifactsDir: string;
  slides?: readonly ReviewSheetSlide[];
}): string {
  const sheet = buildReviewSheetFromJobDir(input);
  const path = reviewSheetPath(input.artifactsDir);
  writeFileSync(path, `${JSON.stringify(sheet, null, 2)}\n`, "utf8");
  return path;
}
