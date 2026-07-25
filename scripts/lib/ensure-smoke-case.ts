/**
 * Создаёт кейс-заглушку, на который смок вешает unified-джобу.
 *
 * `dp_unified_collection_jobs.caseId` — внешний ключ на `cases`, поэтому смок,
 * который просто сохраняет джобу, падает на чужой машине с нарушением
 * ограничения целостности. Четыре смока по оркестрации Arsenkin молча зависели
 * от кейса, оставшегося в БД разработчика.
 */

import { prisma } from "../../src/server/prisma/client";

export async function ensureSmokeCase(caseId: string, subjectName = "Тестов Тест Тестович"): Promise<void> {
  await prisma.case.upsert({
    where: { id: caseId },
    update: {},
    create: {
      id: caseId,
      caseNumber: `SMOKE-${caseId.slice(0, 24)}`,
      title: `Smoke fixture ${caseId}`,
      createdBy: "smoke",
    },
  });
  const subject = await prisma.subject.findFirst({ where: { caseId } });
  if (!subject) {
    await prisma.subject.create({ data: { caseId, fullName: subjectName, aliases: [] } });
  }
}
