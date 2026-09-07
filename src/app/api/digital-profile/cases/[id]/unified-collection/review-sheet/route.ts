/**
 * GET /api/digital-profile/cases/[id]/unified-collection/review-sheet?jobId=…
 *
 * Лист проверки собранного черновика: что напечатано, на каких страницах и что
 * о каждом пункте решила машина. Артефакт пишет подготовка отчёта — здесь его
 * только отдают, ничего не собирая и не создавая.
 *
 * Служебное чтение: лист несёт машинные решения и коды причин, и клиенту он не
 * показывается — право то же, что у остальных внутренних данных модуля.
 */

import { existsSync, readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { jsonOk, withModule, NotFoundError, ValidationError } from "@/modules/digital-profile/http/errors";
import {
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import {
  loadUnifiedCollectionJob,
  unifiedArtifactsDir,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import { reviewSheetPath } from "@/modules/digital-profile/services/review-sheet-artifact";
import {
  applyDecisionsToSheet,
  type ReviewSheet,
} from "@/modules/digital-profile/services/review-sheet";
import {
  listReviewDecisions,
  reviewDecisionsDigest,
  type ReviewDecisionPrisma,
} from "@/modules/digital-profile/services/review-decision-store";
import { prisma } from "@/server/prisma/client";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.viewRaw");
  await requireCaseAccess(user, id, "VIEWER");

  const jobId = req.nextUrl.searchParams.get("jobId") ?? "";
  if (!jobId) throw new ValidationError("jobId is required");

  const job = await loadUnifiedCollectionJob(id);
  if (!job) throw new NotFoundError("no unified job for case");
  // Чужая родословная: спрошенная джоба обязана быть джобой этого дела.
  if (job.unifiedJobId !== jobId && job.jobId !== jobId) {
    throw new NotFoundError("jobId does not match case job");
  }

  const path = reviewSheetPath(unifiedArtifactsDir(id, job.unifiedJobId));
  if (!existsSync(path)) {
    // Отчёт этой джобы собран до появления листа — так и сказано словами.
    throw new NotFoundError("review sheet is not built for this job");
  }
  const sheet = JSON.parse(readFileSync(path, "utf8")) as ReviewSheet;

  /*
   * Действующие решения накладываются при выдаче, а не берутся из файла.
   *
   * В файле стоит отпечаток того набора, который вошёл в **сборку**, — по нему
   * вкладка и узнаёт, что документ старше решений. Показывать при этом
   * устаревший список решений значило бы отвечать на вопрос «что решено» из
   * снимка недельной давности.
   */
  const rows = await listReviewDecisions(id, prisma as unknown as ReviewDecisionPrisma);
  return jsonOk({
    ...applyDecisionsToSheet(sheet, rows),
    /** Отпечаток решений, вошедших в документ. */
    decisionsDigest: sheet.decisionsDigest,
    /** Отпечаток решений на сейчас: расходится — документ надо пересобрать. */
    currentDecisionsDigest: reviewDecisionsDigest(rows),
  });
});
