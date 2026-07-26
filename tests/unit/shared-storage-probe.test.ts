import { describe, expect, it } from "vitest";
import { judgeSharedStorage } from "../../src/modules/digital-profile/workflow/shared-storage-probe";

/**
 * Шаг 12.2 плана.
 *
 * Артефакты прогона пишет воркер, а отдаёт их приложение обычным чтением
 * файла. С отдельным сервисом-воркером это требует общего тома, а на Railway
 * том монтируется ровно к одному сервису. Ошибка в настройке проявилась бы не
 * при старте, а в конце первого платного прогона: сбор прошёл, деньги
 * потрачены, скачать нечего.
 */

const NONE = () => false;
const ALL = () => true;

describe("проверка общего хранилища", () => {
  it("молчит, когда сравнивать не с чем", () => {
    expect(judgeSharedStorage([], NONE)).toMatchObject({ kind: "no_data" });
    expect(judgeSharedStorage([{ unifiedJobId: "j", paths: [] }], NONE)).toMatchObject({
      kind: "no_data",
    });
  });

  it("видит все файлы — хранилище общее", () => {
    const v = judgeSharedStorage([{ unifiedJobId: "j", paths: ["/app/a.json", "/app/b.pdf"] }], ALL);
    expect(v).toEqual({ kind: "ok", checked: 2 });
  });

  it("не видит ни одного — хранилище разное", () => {
    const v = judgeSharedStorage([{ unifiedJobId: "j", paths: ["/app/a.json", "/app/b.pdf"] }], NONE);
    expect(v).toMatchObject({ kind: "not_shared", checked: 2 });
  });

  it("частичная пропажа тревогой не считается", () => {
    // Файлы удаляют штатно: очистка, пересборка отчёта. Тревога только когда
    // не читается вообще ничего — иначе сторож начнёт врать.
    const exists = (p: string) => p.endsWith("b.pdf");
    const v = judgeSharedStorage(
      [{ unifiedJobId: "j", paths: ["/app/a.json", "/app/b.pdf"] }],
      exists
    );
    expect(v.kind).toBe("ok");
  });

  it("пути вне текущего корня хранилища сравнению не подлежат", () => {
    // Запись, сделанная с другим корнем (хост против контейнера), говорит о
    // смене окружения, а не о раздельных дисках. Без этого условия проба
    // поднимала ложную тревогу на локальном стенде, где диск как раз общий.
    const v = judgeSharedStorage(
      [{ unifiedJobId: "j", paths: ["/root/proj/storage/a.json"] }],
      NONE,
      "/app/storage"
    );
    expect(v).toMatchObject({ kind: "no_data" });
  });

  it("пути внутри текущего корня сравниваются как обычно", () => {
    const v = judgeSharedStorage(
      [{ unifiedJobId: "j", paths: ["/app/storage/a.json"] }],
      NONE,
      "/app/storage"
    );
    expect(v).toMatchObject({ kind: "not_shared" });
  });

  it("относительные пути в расчёт не берутся", () => {
    // Ключи хранилища в режиме БД не абсолютны и файлами не являются.
    expect(judgeSharedStorage([{ unifiedJobId: "j", paths: ["case/job/a.json"] }], NONE)).toMatchObject(
      { kind: "no_data" }
    );
  });

  it("складывает пути нескольких прогонов", () => {
    const v = judgeSharedStorage(
      [
        { unifiedJobId: "j1", paths: ["/app/a.json"] },
        { unifiedJobId: "j2", paths: ["/app/b.json"] },
      ],
      NONE
    );
    expect(v).toMatchObject({ kind: "not_shared", checked: 2 });
  });
});
