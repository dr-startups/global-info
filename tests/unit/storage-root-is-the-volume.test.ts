/**
 * Корень хранилища — там, где том.
 *
 * QA MVP 14.09.2026, «Усманов»: снимки LexisNexis и Dow Jones загружены, записи
 * одобрены, ключи записаны — а файлов на диске нет. Приватные файлы шли в
 * `/data/digital-profile` («на Railway том монтируется в /data» — устарело),
 * тогда как том смонтирован в `/app/storage/digital-profile`, куда артефакты
 * прогонов пишут от `process.cwd()`. Два ответа на «где корень»; эфемерный
 * стирался каждым деплоем, и пересборка молча печатала «снимок недоступен».
 *
 * Ответ один: переопределение → путь тома по переменной площадки →
 * `./storage/digital-profile`. `/data` не существует.
 */

import { describe, expect, it } from "vitest";
import { resolveStorageRoot } from "@/modules/digital-profile/config";

describe("корень хранилища", () => {
  it("на Railway с томом — путь тома", () => {
    expect(
      resolveStorageRoot({ RAILWAY_ENVIRONMENT: "production", RAILWAY_VOLUME_MOUNT_PATH: "/app/storage/digital-profile" })
    ).toBe("/app/storage/digital-profile");
  });

  it("переопределение сильнее тома", () => {
    expect(
      resolveStorageRoot({
        RAILWAY_ENVIRONMENT: "production",
        RAILWAY_VOLUME_MOUNT_PATH: "/app/storage/digital-profile",
        DIGITAL_PROFILE_STORAGE_ROOT: "/mnt/other",
      })
    ).toBe("/mnt/other");
    expect(resolveStorageRoot({ DIGITAL_PROFILE_STORAGE_DIR: "/mnt/dir" })).toBe("/mnt/dir");
    expect(resolveStorageRoot({ DIGITAL_PROFILE_STORAGE_ROOT: "  " })).toBe("./storage/digital-profile");
  });

  it("без Railway — рабочая копия; на Railway без переменной тома — тот же ответ, что у артефактов, а не /data", () => {
    expect(resolveStorageRoot({})).toBe("./storage/digital-profile");
    expect(resolveStorageRoot({ RAILWAY_ENVIRONMENT: "production" })).toBe("./storage/digital-profile");
  });
});
