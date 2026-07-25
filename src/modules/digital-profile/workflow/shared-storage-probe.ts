/**
 * Проверка того, что воркер и приложение видят одно хранилище (шаг 12.2).
 *
 * Артефакты прогона — манифесты, чекпойнты, собранные PDF и PPTX — пишутся на
 * диск, а отдаёт их приложение обычным чтением файла. Пока всё жило в одном
 * процессе, это было незаметно. С отдельным сервисом-воркером появляется
 * условие: **том должен быть общим**, а на Railway том монтируется ровно к
 * одному сервису.
 *
 * Ошибка в этой настройке проявилась бы не при старте, а в конце первого
 * платного прогона: сбор прошёл, деньги потрачены, а скачать нечего. Поэтому
 * воркер проверяет доступность чужих артефактов при запуске и говорит прямо.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export type StorageProbeVerdict =
  | { kind: "ok"; checked: number }
  | { kind: "no_data"; reason: string }
  | { kind: "not_shared"; missing: string[]; checked: number };

export type ProbeJobArtifacts = {
  unifiedJobId: string;
  /** Абсолютные пути артефактов, записанные прошлыми прогонами. */
  paths: string[];
};

/**
 * Вердикт по списку известных артефактов.
 *
 * Чистая функция: проверка существования файла инжектируется, чтобы правило
 * можно было проверить тестом.
 */
export function judgeSharedStorage(
  jobs: readonly ProbeJobArtifacts[],
  fileExists: (path: string) => boolean,
  /**
   * Корень хранилища этого процесса. Пути вне него сравнению не подлежат:
   * запись, сделанная с другим корнем (хост против контейнера), говорит о
   * смене окружения, а не о раздельных дисках. Без этого условия проба
   * поднимала ложную тревогу на локальном стенде, где диск как раз общий.
   */
  storageRoot?: string
): StorageProbeVerdict {
  const root = String(storageRoot ?? "").trim();
  const paths = jobs
    .flatMap((j) => j.paths)
    .filter((p) => p.startsWith("/"))
    .filter((p) => !root || p.startsWith(root));
  if (paths.length === 0) {
    // Свежее развёртывание либо смена корня: сравнивать не с чем.
    return { kind: "no_data", reason: "нет сопоставимых артефактов прошлых прогонов" };
  }

  const missing = paths.filter((p) => !fileExists(p));
  // Часть файлов может быть удалена штатно (очистка, пересборка), поэтому
  // тревога поднимается только когда не видно вообще ничего.
  if (missing.length === paths.length) {
    return { kind: "not_shared", missing: missing.slice(0, 5), checked: paths.length };
  }
  return { kind: "ok", checked: paths.length };
}

export const NOT_SHARED_MESSAGE = [
  "[worker] Хранилище не общее с приложением.",
  "Ни один артефакт прошлых прогонов не читается с этого диска.",
  "Собранный отчёт окажется на диске воркера, а отдаёт файлы приложение —",
  "прогон завершится успешно, но скачать будет нечего.",
  "На Railway том монтируется к одному сервису: либо держите воркер и приложение",
  "одним сервисом, либо переносите артефакты в общее хранилище.",
].join(" ");

/** Корень хранилища этого процесса. */
export function storageRoot(): string {
  return (
    process.env.DIGITAL_PROFILE_STORAGE_ROOT?.trim() ||
    join(process.cwd(), "storage", "digital-profile")
  );
}

/** Читает пути артефактов последних прогонов и выносит вердикт. */
export async function probeSharedStorage(limit = 5): Promise<StorageProbeVerdict> {
  try {
    const { prisma } = await import("@/server/prisma/client");
    const rows = await prisma.unifiedCollectionJobRecord.findMany({
      orderBy: { updatedAt: "desc" },
      take: limit,
      select: { unifiedJobId: true, artifactKeys: true },
    });
    const jobs: ProbeJobArtifacts[] = rows.map((r) => ({
      unifiedJobId: r.unifiedJobId,
      paths: Object.values((r.artifactKeys ?? {}) as Record<string, unknown>)
        .map((v) => String(v ?? ""))
        .filter(Boolean),
    }));
    return judgeSharedStorage(jobs, existsSync, storageRoot());
  } catch (err) {
    return {
      kind: "no_data",
      reason: `проверка не выполнена: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
