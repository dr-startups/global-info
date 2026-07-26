import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isUnifiedPollDue } from "../../src/modules/digital-profile/services/unified-collection-job-store";
import {
  MAX_IDLE_POLLS,
  pollBackoffMs,
} from "../../src/modules/digital-profile/services/arsenkin-poll-budget";

/**
 * Пауза, которую вычислили, обязана соблюдаться.
 *
 * Замер на живом прогоне: счётчик простоя рос на 16 в минуту при `nextPollAt`,
 * отстоящем на 15–30 секунд. Причина — подборка возобновляемых прогонов
 * отбирала работу по стадии и статусу и на `nextPollAt` не смотрела вовсе, а
 * оборот обслуживания идёт раз в пять секунд. То есть стадию дёргали
 * двенадцать раз в минуту независимо от назначенного времени.
 *
 * Последствие ровно то, на что жаловался заказчик: бюджет в 40 опросов без
 * продвижения сгорал за две с половиной минуты вместо восемнадцати.
 * Инструменты Arsenkin идут минутами (`check-top` — три-шесть), поэтому
 * исправный прогон объявлялся застоем и предлагал платный пересбор.
 *
 * Это третий случай одной и той же формы: ответ на вопрос «когда опрашивать
 * снова» давали в одном месте и игнорировали в другом.
 */

const source = readFileSync(
  join(process.cwd(), "src/modules/digital-profile/services/unified-collection-job-store.ts"),
  "utf8"
);

const between = (from: string, to: string): string => {
  const start = source.indexOf(from);
  expect(start, `не найдено: ${from}`).toBeGreaterThan(-1);
  const end = source.indexOf(to, start);
  return source.slice(start, end === -1 ? undefined : end);
};

describe("подборка возобновляемых прогонов соблюдает паузу", () => {
  it("запрос в БД отбирает только те, чей срок настал", () => {
    const fn = between("async function dbListResumable", "async function dbDelete");
    expect(fn).toMatch(/nextPollAt:\s*null/u);
    expect(fn).toMatch(/nextPollAt:\s*\{\s*lte:\s*now\s*\}/u);
  });

  it("файловый режим соблюдает её тоже", () => {
    const fn = between("async function fileListResumable", "async function fileDelete");
    expect(fn).toMatch(/isUnifiedPollDue/u);
  });

  it("отсутствие отметки означает «можно опрашивать»", () => {
    const now = new Date("2026-07-26T18:00:00.000Z");
    // Только что созданная джоба ещё ни разу не опрашивалась.
    expect(isUnifiedPollDue(null, now)).toBe(true);
    // Испорченное значение не должно останавливать прогон навсегда.
    expect(isUnifiedPollDue("не дата", now)).toBe(true);
  });

  it("срок в будущем откладывает опрос, в прошлом — разрешает", () => {
    const now = new Date("2026-07-26T18:00:00.000Z");
    expect(isUnifiedPollDue("2026-07-26T18:00:30.000Z", now)).toBe(false);
    expect(isUnifiedPollDue(new Date("2026-07-26T17:59:59.000Z"), now)).toBe(true);
    // Ровно наступивший срок — уже можно.
    expect(isUnifiedPollDue(new Date(now), now)).toBe(true);
  });

  it("бюджет ожидания при соблюдённой паузе покрывает работу провайдера", () => {
    // Сорок опросов при растущей паузе — это уже не «долго считает».
    // `check-top` идёт три-шесть минут, и он обязан укладываться с запасом.
    let waited = 0;
    for (let idle = 0; idle <= MAX_IDLE_POLLS; idle += 1) waited += pollBackoffMs(idle);
    expect(waited / 60_000).toBeGreaterThan(15);
  });
});
