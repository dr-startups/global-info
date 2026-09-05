/**
 * Снимок называет запрос, который называет субъекта целиком.
 *
 * Отчёт 86, лист «ОАЭ — снимок выдачи»: в строке поиска стоит «Egorov Aleksey»
 * — без отчества, хотя сбор шёл и по «Egorov Aleksey Evgenevich» (55
 * наблюдений против 33). Клиент читает снимок как «вот что ищут про меня»:
 * запрос без отчества занижает то, что мы на самом деле проверяли.
 *
 * Правило: среди запросов нарисованных строк побеждает тот, что несёт больше
 * частей имени субъекта; при равенстве — с меньшим числом лишних слов; дальше
 * — самый частый; дальше — первый по порядку.
 */

import { describe, expect, it } from "vitest";
import { snapshotQueryOf } from "@/modules/digital-profile/services/canonical-visual-assets";

const SUBJECT = "Егоров Алексей Евгеньевич";

describe("запрос снимка называет субъекта целиком", () => {
  it("латинский контур: отчество побеждает частоту", () => {
    const queries = [
      ...Array(33).fill("Egorov Aleksey"),
      ...Array(24).fill("Egorov Aleksey Evgenevich"),
    ];
    expect(snapshotQueryOf(queries, SUBJECT)).toBe("Egorov Aleksey Evgenevich");
  });

  it("русский контур: лишние слова уступают чистому имени", () => {
    const queries = [
      ...Array(66).fill("Егоров Алексей Евгеньевич новости"),
      ...Array(65).fill("Егоров Алексей Евгеньевич"),
    ];
    expect(snapshotQueryOf(queries, SUBJECT)).toBe("Егоров Алексей Евгеньевич");
  });

  it("при равном имени решает частота", () => {
    const queries = [
      ...Array(3).fill("Егоров Алексей Евгеньевич инн"),
      ...Array(9).fill("Егоров Алексей Евгеньевич огрн"),
    ];
    expect(snapshotQueryOf(queries, SUBJECT)).toBe("Егоров Алексей Евгеньевич огрн");
  });

  it("запросов нет — остаётся имя субъекта", () => {
    expect(snapshotQueryOf([], SUBJECT)).toBe(SUBJECT);
  });
});
