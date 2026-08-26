/**
 * «Негативна ли строка» — один ответ и один словарь.
 *
 * На отчёте Кремлёва на этот вопрос отвечали пять мест по двум несовпадающим
 * словарям: `ADVERSE_PATTERNS` из конфига знал «суд» и «скандал», а blob-словарь
 * снимка — «ofac» и «offshore». Отсюда стр. 35 с заголовком «негативных
 * источников нет» над телом «негативных заголовков — 1» и klerk.ru,
 * «Нежелательный» по принадлежности к теме при прочитанной и благоприятной
 * странице.
 *
 * Здесь закреплён сам предикат: порядок решений, стороны, в которые действует
 * прочитанная страница, и то, что домен отвечает своим списком, а не словарём.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveRowAdverse,
  type ObservationVerdict,
} from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";

const HIGHLIGHTS_SOURCE = join(
  process.cwd(),
  "src/modules/digital-profile/serp-observation/resolve-observation-highlights.ts"
);

/** Прочитанная страница с дословной цитатой. */
function verdict(over: Partial<ObservationVerdict> = {}): ObservationVerdict {
  return { tone: "adverse", quoted: true, subjectMatch: "subject", ...over };
}

describe("решение по прочитанной странице сильнее словаря в обе стороны", () => {
  it("нейтральный вердикт снимает совпадение по слову «скандал»", () => {
    expect(
      resolveRowAdverse(
        {
          url: "https://news-example.ru/a",
          domain: "news-example.ru",
          title: "Кремлёв Умар Назарович: биография, бизнес, скандалы",
        },
        verdict({ tone: "neutral" })
      )
    ).toBe(false);
  });

  it("благоприятный вердикт снимает совпадение по слову «суд»", () => {
    expect(
      resolveRowAdverse(
        { url: "https://klerk.ru/buh/news/1", domain: "klerk.ru", title: "Суд отказал в иске" },
        verdict({ tone: "supportive" })
      )
    ).toBe(false);
  });

  it("материал о другом лице не негативен даже на негативной площадке", () => {
    expect(
      resolveRowAdverse(
        { url: "https://rucriminal.info/dosje/1", domain: "rucriminal.info", title: "Досье" },
        verdict({ subjectMatch: "other" })
      )
    ).toBe(false);
  });

  it("нежелательный вердикт с цитатой краснит строку без единого слова словаря", () => {
    expect(
      resolveRowAdverse(
        { url: "https://news-example.ru/b", domain: "news-example.ru", title: "Интервью" },
        verdict()
      )
    ).toBe(true);
  });

  it("нежелательный вердикт без цитаты решения не приносит — отвечает словарь", () => {
    const noQuote = verdict({ quoted: false });
    expect(
      resolveRowAdverse(
        { url: "https://news-example.ru/c", domain: "news-example.ru", title: "Интервью о планах" },
        noQuote
      )
    ).toBe(false);
    expect(
      resolveRowAdverse(
        {
          url: "https://news-example.ru/d",
          domain: "news-example.ru",
          title: "Суд назначил слушание",
        },
        noQuote
      )
    ).toBe(true);
  });
});

describe("словарь читает заголовок и сниппет, домен отвечает своим списком", () => {
  it("совпадение в сниппете считается наравне с заголовком", () => {
    expect(
      resolveRowAdverse({
        url: "https://news-example.ru/e",
        domain: "news-example.ru",
        title: "Итоги года",
        snippet: "Прокуратура запросила документы у компании",
      })
    ).toBe(true);
  });

  it("негативная площадка краснеет без единого слова словаря", () => {
    expect(
      resolveRowAdverse({
        url: "https://www.opensanctions.org/entities/Q55102113/",
        domain: "opensanctions.org",
        title: "Umar Nazarovich Kremlev",
      })
    ).toBe(true);
  });

  it("домен предикатом не читается: чистая строка на «investigator» не краснеет", () => {
    expect(
      resolveRowAdverse({
        url: "https://theinvestigatornews.com/2024/07/boxing",
        domain: "theinvestigatornews.com",
        title: "Итоги турнира по боксу",
        snippet: "Финал прошёл в Дубае.",
      })
    ).toBe(false);
  });

  it("слово словаря на границе домена тоже не читается", () => {
    // `theinvestigatornews` предикат не поймал бы ни при какой реализации:
    // перед «investigat» стоит буква, а словарь скомпилирован с левой
    // границей. Здесь слово стоит в начале хоста и в начале сегмента пути —
    // если бы предикат читал адрес, совпадение было бы.
    expect(
      resolveRowAdverse({
        url: "https://court-news.example/2024/court-calendar",
        domain: "court-news.example",
        title: "Расписание заседаний спортивной федерации",
        snippet: "Календарь мероприятий на год.",
      })
    ).toBe(false);
  });

  it("хвост-бренд площадки в заголовке краснит строку — и на любом домене одинаково", () => {
    const title = "Kremlev's boxing empire – The Investigator News";
    expect(
      resolveRowAdverse({
        url: "https://theinvestigatornews.com/2024/08/kremlev",
        domain: "theinvestigatornews.com",
        title,
      })
    ).toBe(true);
    expect(
      resolveRowAdverse({ url: "https://example.com/x", domain: "example.com", title })
    ).toBe(true);
  });
});

describe("мягкие площадки не краснеют по словарю, но краснеют по списку", () => {
  const title = "Кремлёв Умар Назарович: биография, бизнес, скандалы";

  it("ru.wikipedia.org со словом «скандалы» не негативна", () => {
    expect(
      resolveRowAdverse({
        url: "https://ru.wikipedia.org/wiki/Кремлёв",
        domain: "ru.wikipedia.org",
        title,
      })
    ).toBe(false);
  });

  it("ru.ruwiki.ru со словом «скандалы» не негативна", () => {
    expect(
      resolveRowAdverse({ url: "https://ru.ruwiki.ru/wiki/Кремлёв", domain: "ru.ruwiki.ru", title })
    ).toBe(false);
  });

  it("wikiwand со словом «скандалы» не негативна", () => {
    expect(
      resolveRowAdverse({
        url: "https://www.wikiwand.com/ru/articles/Кремлёв",
        domain: "wikiwand.com",
        title,
      })
    ).toBe(false);
  });

  it("тот же заголовок на обычной площадке негативен", () => {
    expect(
      resolveRowAdverse({ url: "https://news-example.ru/f", domain: "news-example.ru", title })
    ).toBe(true);
  });

  it("мягкая площадка из списка негативных всё равно краснеет", () => {
    // `rupep.` стоит в списке площадок, а слов словаря в заголовке нет.
    expect(
      resolveRowAdverse({
        url: "https://rupep.org/en/person/49596",
        domain: "rupep.org",
        title: "Umar Kremlev",
      })
    ).toBe(true);
  });
});

describe("мягкая площадка не слепа для сильных слов", () => {
  it("пост в соцсети про уголовное дело краснеет", () => {
    expect(
      resolveRowAdverse({
        url: "https://x.com/someone/status/1",
        domain: "x.com",
        title: "Уголовное дело против предпринимателя",
      })
    ).toBe(true);
  });

  it("энциклопедия со словом «арест» в заголовке краснеет", () => {
    expect(
      resolveRowAdverse({
        url: "https://ru.wikipedia.org/wiki/Дело",
        domain: "ru.wikipedia.org",
        title: "Арест активов предпринимателя",
      })
    ).toBe(true);
  });

  it("а слабое слово на той же площадке — нет", () => {
    expect(
      resolveRowAdverse({
        url: "https://ru.wikipedia.org/wiki/Кремлёв",
        domain: "ru.wikipedia.org",
        title: "Кремлёв Умар Назарович: биография, бизнес, скандалы",
      })
    ).toBe(false);
  });

  it("сильные слова — подмножество общего словаря, а не второй словарь", () => {
    // Слово, краснящее мягкую площадку, обязано краснить и обычную: иначе это
    // не «сильное подмножество», а второй словарь с собственным составом.
    for (const title of [
      "Уголовное дело против предпринимателя",
      "Арест активов предпринимателя",
      "Санкции против компании",
      "Коррупционный скандал в ведомстве",
      "Мошенничество при поставках",
      "Fraud investigation opened",
      "Criminal case filed",
      "Компромат на предпринимателя",
    ]) {
      expect(
        resolveRowAdverse({ url: "https://news-example.ru/x", domain: "news-example.ru", title })
      ).toBe(true);
      expect(resolveRowAdverse({ url: "https://x.com/a/1", domain: "x.com", title })).toBe(true);
    }
  });
});

describe("агрегатор компромата опознаётся по адресу", () => {
  it("репост rucriminal в соцсети негативен", () => {
    expect(
      resolveRowAdverse({
        url: "https://x.com/rucriminalinfo/status/2008361452998914141?lang=ru",
        domain: "x.com",
        title: "https://x.com/rucriminalinfo/status/2008361452998914141?lang=ru",
      })
    ).toBe(true);
  });

  it("сам агрегатор — тоже", () => {
    expect(
      resolveRowAdverse({
        url: "https://rucriminal.info/en/dosje/125",
        domain: "rucriminal.info",
        title: "Dossier",
      })
    ).toBe(true);
  });
});

describe("«courts» как «обхаживает» строку не краснит", () => {
  it("Gulf press: … courts Gulf family offices — не негативна", () => {
    expect(
      resolveRowAdverse({
        url: "https://difc-briefing.ae/2024/gulf",
        domain: "difc-briefing.ae",
        title: "Gulf press: Anders Holmström courts Gulf family offices for Nordkap Capital",
      })
    ).toBe(false);
  });

  it("Stockholm court schedules hearing — негативна", () => {
    expect(
      resolveRowAdverse({
        url: "https://kapitalnytt.se/2024/hearing",
        domain: "kapitalnytt.se",
        title: "Stockholm court schedules hearing involving Anders Holmström of Nordkap Capital",
      })
    ).toBe(true);
  });

  it("русский «суд» и его формы по-прежнему краснят", () => {
    for (const title of ["Суд назначил слушание", "Судебное разбирательство продолжается"]) {
      expect(
        resolveRowAdverse({ url: "https://news-example.ru/y", domain: "news-example.ru", title })
      ).toBe(true);
    }
  });
});

describe("словарь негатива в проекте один", () => {
  const source = readFileSync(HIGHLIGHTS_SOURCE, "utf8");

  it("blob-словарей в разборе не осталось", () => {
    expect(source).not.toContain("STRONG_ADVERSE_BLOB_RE");
    expect(source).not.toContain("WEAK_ADVERSE_BLOB_RE");
  });

  it("предикат берёт слова из конфига, а своих выражений не заводит", () => {
    const start = source.indexOf("export function resolveRowAdverse");
    expect(start).toBeGreaterThan(-1);
    const rest = source.slice(start);
    const end = rest.indexOf("\n}\n");
    expect(end).toBeGreaterThan(-1);
    const body = rest.slice(0, end);
    expect(body).toContain("getAdversePatterns()");
    // Литералов регулярных выражений в теле нет вовсе: слова живут в конфиге,
    // площадки — в двух названных списках выше по файлу.
    expect(body.match(/\/[^/\s][^\n]*\/[a-z]*\.test\(/g)).toBeNull();
    const named = body.match(/[A-Z][A-Z0-9_]{3,}/g) ?? [];
    expect([...new Set(named)].sort()).toEqual(["ADVERSE_DOMAIN_RE", "SOFT_PROFILE_DOMAIN_RE"]);
  });
});
