/**
 * Текст в картинке-панели меряется метрикой шрифта, а не средним знаком (шаг 0116).
 *
 * Стр. 40 отчёта Бондарчука 19.09.2026: текст ИИ-ответа в панели выходит за
 * правый край карточки на каждой строке. Перенос считал ширину как
 * `длина × кегль × 0.52`, а растеризует панель DejaVu Sans, у которого
 * кириллица на 13 % шире этой оценки. Эталонные числа сняты PIL с файла
 * `DejaVuSans.ttf` (ImageFont.truetype(…, 14).getlength) — тем же шрифтом,
 * которым sharp/librsvg рисует панель в образе `app` (fonts-dejavu-core).
 */

import { describe, expect, it } from "vitest";
import {
  estTextWidth,
  truncateToWidth,
  wrapToWidth,
} from "@/modules/digital-profile/serp-snapshot/layout";

const RU_LINE =
  "Фёдор Сергеевич Бондарчук—советский и российский актёр кино, телевидения, озвучивания и дубляжа, режиссёр, продюсер, телеведущий, клипмейкер.";
const EN_LINE =
  "Fyodor Bondarchuk is a Russian film director, actor and producer, member of the United Russia party.";
const SOURCES_LINE =
  "Источники: ru.wikipedia.org, doc.ru, rbc.ru, tass.ru, mk.ru, smotrim.ru, wink.ru, okko.tv, 24smi.org, gazeta.ru";

/** Замер PIL по DejaVuSans.ttf при 14 px. */
const MEASURED_14PX = { ru: 1160.4, en: 711.6, sources: 771.4 };

const ANSWER =
  "Фёдор Сергеевич Бондарчук—советский и российский актёр кино, телевидения, озвучивания и дубляжа, режиссёр, продюсер, телеведущий, клипмейкер. " +
  "Родился 9мая 1967года в Москве в семье режиссёра Сергея Бондарчука и актрисы Ирины Скобцевой. Актёрская карьера Дебютировал в кино в 1986году в исторической драме отца «Борис Годунов», где сыграл роль царевича Фёдора. " +
  "В студенческие годы снимался в фильмах «86400секунд работы дежурной части милиции» (1988) и «Сталинград» (1989). Широкую известность принесла роль князя Мышкина в постмодернистской картине Романа Качанова «Даун Хаус» (2001)—интерпретации романа Достоевского «Идиот».";

function within(actual: number, expected: number, share: number): boolean {
  return Math.abs(actual - expected) <= expected * share;
}

describe("ширина текста панели — по метрике DejaVu Sans", () => {
  it("Ш1: кириллическая строка ответа при 14 px меряется как в шрифте (±1 %)", () => {
    const w = estTextWidth(RU_LINE, 14);
    expect(within(w, MEASURED_14PX.ru, 0.01), `оценка ${w.toFixed(1)} px, шрифт ${MEASURED_14PX.ru}`).toBe(true);
  });

  it("Ш2: латинская строка и строка источников — тоже (±1 %)", () => {
    const en = estTextWidth(EN_LINE, 14);
    const src = estTextWidth(SOURCES_LINE, 14);
    expect(within(en, MEASURED_14PX.en, 0.01), `оценка ${en.toFixed(1)} px, шрифт ${MEASURED_14PX.en}`).toBe(true);
    expect(within(src, MEASURED_14PX.sources, 0.01), `оценка ${src.toFixed(1)} px, шрифт ${MEASURED_14PX.sources}`).toBe(true);
  });

  it("Ш3: перенос ответа на 1072 px не даёт строки шире 1072 px по той же мере", () => {
    const lines = wrapToWidth(ANSWER, 1072, 14, 11);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      const w = estTextWidth(line.replace(/…$/u, ""), 14);
      expect(w, `строка «${line.slice(0, 40)}…» = ${w.toFixed(1)} px`).toBeLessThanOrEqual(1072);
    }
  });

  it("Ш4: обрезка кириллического заголовка не шире заданной ширины", () => {
    const title = "Фёдор Бондарчук — последние новости на сегодня: премьеры, интервью, семья и бизнес";
    const cut = truncateToWidth(title, 300, 14);
    expect(cut.endsWith("…")).toBe(true);
    expect(estTextWidth(cut, 14)).toBeLessThanOrEqual(300);
  });
});
