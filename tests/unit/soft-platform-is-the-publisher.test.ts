/**
 * Мягкая площадка — свойство издателя, и список читает хост.
 *
 * Список мягких площадок стоял без левой границы и сверялся с адресом целиком.
 * Обе неточности отдавали сигнал молча: `netflix.com`, `linux.com`,
 * `forex.com`, `yandex.com` — любой хост, оканчивающийся на `x.com`, — судились
 * сильным подмножеством словаря вместо полного, а обычному изданию хватало
 * трекинг-метки `?utm_source=x.com`, чтобы стать «биографией».
 *
 * Здесь закреплены оба входа: что мягкость определяет **имя хоста** и что
 * соседний список негативных площадок продолжает читать **весь адрес**, потому
 * что отвечает на другой вопрос.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRowAdverse } from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";

/**
 * Заголовок со слабым словом словаря: «скандалы» краснит обычную площадку и
 * молчит на мягкой. Это и есть наблюдаемая разница между двумя словарями —
 * другого способа спросить «мягкая ли площадка» снаружи нет.
 */
const WEAK_TITLE = "Кремлёв Умар Назарович: биография, бизнес, скандалы";

/** Каким словарём судится строка этого хоста. */
function judgedAs(domain: string, url = `https://${domain}/a`): "мягкая" | "обычная" {
  return resolveRowAdverse({ url, domain, title: WEAK_TITLE }) ? "обычная" : "мягкая";
}

/** Ожидание по списку хостов — падение называет хост, а не «false !== true». */
function expectAll(hosts: string[], verdict: "мягкая" | "обычная") {
  expect(Object.fromEntries(hosts.map((h) => [h, judgedAs(h)]))).toEqual(
    Object.fromEntries(hosts.map((h) => [h, verdict]))
  );
}

/**
 * Список мягких площадок поимённо: имя → хост, на котором оно живёт.
 *
 * Таблица нужна ровно затем, что граница у каждого имени своя: восемь имён из
 * семнадцати держались только сторожем отпечатка, и любое из них выносилось из
 * группы без границы при зелёном `npm test`. Приставку и поддомен проверки
 * ниже выводят отсюда же, поэтому имя, добавленное завтра, получает все три
 * проверки за одну строку таблицы — а забыть строку не даёт сверка со списком
 * в коде.
 *
 * `x.com` названа хостом целиком: имя `x` в общем списке значило бы «`x` на
 * любом домене верхнего уровня», то есть `x.ru` и `x.org` тоже.
 */
const SOFT_PLATFORM_HOSTS: Record<string, string> = {
  forbes: "forbes.ru",
  klerk: "klerk.ru",
  tadviser: "tadviser.ru",
  wikipedia: "wikipedia.org",
  ruwiki: "ruwiki.ru",
  wikiwand: "wikiwand.com",
  linkedin: "linkedin.com",
  rusprofile: "rusprofile.ru",
  "audit-it": "audit-it.ru",
  zachestnyibiznes: "zachestnyibiznes.ru",
  labyrinth: "labyrinth.ru",
  instagram: "instagram.com",
  facebook: "facebook.com",
  twitter: "twitter.com",
  youtube: "youtube.com",
  imslp: "imslp.org",
  "x.com": "x.com",
};

const RESOLVER_PATH = join(
  process.cwd(),
  "src/modules/digital-profile/serp-observation/resolve-observation-highlights.ts"
);

/**
 * Имена, разобранные из самого списка в коде.
 *
 * Снаружи список не виден — предикат отвечает «да/нет» по одному хосту, — а
 * знать его состав нужно: иначе таблица выше закрывает сегодняшний список и
 * молчит о завтрашнем. Разбор снимает левую границу (`(?:^|\.)` — не имя),
 * скобки групп и завершающую точку, а `\.` внутри имени возвращает точкой:
 * `x\.com` — это `x.com`.
 */
function namesInSource(): string[] {
  const source = readFileSync(RESOLVER_PATH, "utf8");
  const literal = /const SOFT_PROFILE_DOMAIN_RE =\s*(\/[^\n]*\/[a-z]*);/.exec(source)?.[1];
  expect(
    literal,
    "список мягких площадок перестал быть regexp-литералом — поправь разбор здесь"
  ).toBeTruthy();
  const names = String(literal)
    .replace(/^\//, "")
    .replace(/\/[a-z]*$/, "")
    .replaceAll("(?:^|\\.)", "|")
    .replace(/\(\?:|\)/g, "")
    .split("|")
    .map((alternative) => alternative.replace(/\\\.$/, "").replaceAll("\\.", "."))
    .filter(Boolean);
  // Разбор обязан отдавать имена хостов, а не куски выражения. Без этой строки
  // переработка формы (`(?:^|\.)` → захватывающая `(^|\.)`, `\b` вместо
  // границы) роняет сверку с таблицей, показывая в диффе `"(^"` и `".forbes"`, —
  // и самая дешёвая «починка» состоит в том, чтобы дописать этот мусор в
  // таблицу. После неё сверка зелена, а разбор не значит ничего: производные
  // проверки уходят на `not(^` и `sub.(^`. Здесь названа настоящая причина.
  for (const name of names) {
    expect(
      name,
      "разобранное имя не похоже на имя хоста — значит, форма выражения изменилась и " +
        "разбор за ней не поспел. Правь namesInSource, а не SOFT_PLATFORM_HOSTS"
    ).toMatch(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/);
  }
  return names;
}

describe("у списка мягких площадок есть левая граница", () => {
  it("хост, лишь оканчивающийся на x.com, мягким не является", () => {
    // Самая широкая из потерь: `x\.com` без границы делает мягким любой хост
    // с таким суффиксом, а таких доменов — целый класс живых изданий и
    // сервисов.
    expectAll(
      [
        "netflix.com",
        "linux.com",
        "forex.com",
        "fintechx.com",
        "yandex.com",
        "dropbox.com",
        "fedex.com",
        "equifax.com",
        "citrix.com",
        "phoenix.com",
      ],
      "обычная"
    );
  });

  it("таблица имён совпадает со списком в коде", () => {
    // Три проверки ниже выводятся из таблицы, поэтому её отставание от кода —
    // это молчащая проверка, а не расхождение документации. Имя, добавленное в
    // список и не добавленное сюда, краснит здесь.
    expect(namesInSource().sort()).toEqual(Object.keys(SOFT_PLATFORM_HOSTS).sort());
  });

  it("каждое имя списка мягкое на своём хосте", () => {
    expectAll(Object.values(SOFT_PLATFORM_HOSTS), "мягкая");
  });

  it("приставка перед именем мягкой площадки её мягкости не даёт", () => {
    expectAll(
      [
        ...Object.values(SOFT_PLATFORM_HOSTS).map((host) => `not${host}`),
        // Живые приставки в придачу к машинной: имена площадок встречаются
        // внутри чужих доменов не только с `not`. Приставка через дефис — не
        // украшение списка: у формы `\b` вместо левой границы она мягкая, и
        // разбор выражения такую подмену ловит, а поведение — только здесь.
        "fake-forbes.ru",
        "my-forbes.ru",
        "the-x.com",
        "myforbes.ru",
        "fakefacebook.com",
        "fakewikipedia.com",
        "notadviser.com",
        "datalabyrinth.com",
        "norusprofile.ru",
      ],
      "обычная"
    );
  });

  it("поддомен мягкой площадки — тоже мягкая площадка", () => {
    // Граница ставится «в начале хоста или после точки» именно ради этого:
    // региональные и мобильные поддомены — те же издатели.
    expectAll(
      [
        ...Object.values(SOFT_PLATFORM_HOSTS).map((host) => `sub.${host}`),
        "m.facebook.com",
        "mobile.twitter.com",
        "en.m.wikipedia.org",
        "ru.ruwiki.ru",
        "l.instagram.com",
        "music.youtube.com",
        "ru.linkedin.com",
      ],
      "мягкая"
    );
  });

  it("`x.com` названа хостом целиком: `x` на другом домене — не соцсеть", () => {
    // Единственное имя списка, у которого значим домен верхнего уровня.
    // Свернуть его внутрь общей группы имён — значит объявить мягким `x` на
    // любом домене; односимвольные имена живут у кого угодно.
    expectAll(["x.ru", "x.org", "x.net"], "обычная");
    expect(judgedAs("x.com")).toBe("мягкая");
  });
});

describe("мягкость определяет хост, а не весь адрес", () => {
  it("трекинг-метка со ссылкой на соцсеть издание мягким не делает", () => {
    for (const url of [
      "https://example.com/news?utm_source=x.com",
      "https://rbc-example.ru/politics/2025/glinka?ref=x.com",
      "https://kommersant-example.ru/doc/1?from=twitter.com",
      "https://interfax-example.ru/russia/1?src=facebook.com",
    ]) {
      expect(resolveRowAdverse({ url, domain: new URL(url).hostname, title: WEAK_TITLE })).toBe(
        true
      );
    }
  });

  it("имя мягкой площадки в пути издание мягким не делает", () => {
    for (const url of [
      "https://vc-example.ru/legal/1-forbes.html",
      "https://gazeta-example.ru/social/2025/instagram.shtml",
      "https://lenta-example.ru/news/2025/08/27/x.com-sud/",
    ]) {
      expect(resolveRowAdverse({ url, domain: new URL(url).hostname, title: WEAK_TITLE })).toBe(
        true
      );
    }
  });

  it("без записанного домена хост берётся из адреса", () => {
    // Спрашивают хост, но у строки бывает только адрес. Обе стороны — иначе
    // проверка зелена и без вывода хоста: `example.com` мягким не станет никак,
    // и совпадение ответов оказывается случайным.
    expect(
      resolveRowAdverse({ url: "https://ru.wikipedia.org/wiki/Кремлёв", title: WEAK_TITLE })
    ).toBe(false);
    expect(
      resolveRowAdverse({ url: "https://example.com/news?utm_source=x.com", title: WEAK_TITLE })
    ).toBe(true);
  });

  it("чужой хост, процитированный внутри адреса, издателя не подменяет", () => {
    // Единственный вход, разделяющий две половины правки. В случаях выше имя
    // мягкой площадки стоит после `=`, `-` или `/`, и одной левой границы
    // хватило бы, чтобы их снять. Здесь имя стоит **после точки** — границу
    // проходит, — и ложным перестаёт быть только потому, что спрашивают хост.
    // Так выглядят живые редиректы, зеркала и ссылки «поделиться»: адрес несёт
    // внутри себя другой адрес.
    for (const [url, domain] of [
      ["https://news-example.ru/out?url=https://ru.wikipedia.org/wiki/Кремлёв", "news-example.ru"],
      ["https://news-example.ru/go?to=www.forbes.ru/article-1", "news-example.ru"],
      ["https://blog-example.ru/kak-my-delali-m.facebook.com-integraciyu", "blog-example.ru"],
    ]) {
      expect(resolveRowAdverse({ url, domain, title: WEAK_TITLE })).toBe(true);
    }
  });
});

describe("список негативных площадок читает весь адрес — это другой вопрос", () => {
  /*
   * Два списка стоят рядом, и входы у них разные не по недосмотру.
   *
   * Мягкий спрашивает «кто издатель» — ответ целиком в имени хоста, путь на
   * него не отвечает: раздел сайта издателя не меняет.
   *
   * Соседний спрашивает «кто это перепечатал» — и перепечатка видна ровно в
   * пути: `x.com/rucriminalinfo/…` издан соцсетью, а принесён агрегатором
   * компромата, и в хосте `x.com` слова `rucriminal` нет вовсе.
   *
   * Поэтому если этот тест покраснел от «согласования» двух списков по одному
   * входу — это не согласование, а возврат потери сигнала на перепечатках.
   */
  it("репост агрегатора краснеет, хотя его хост — мягкая площадка", () => {
    expect(judgedAs("x.com")).toBe("мягкая");
    expect(
      resolveRowAdverse({
        url: "https://x.com/rucriminalinfo/status/2008361452998914141?lang=ru",
        domain: "x.com",
        title: "Репост",
      })
    ).toBe(true);
  });

  it("в хосте того же материала сигнала агрегатора нет", () => {
    // Ровно то, что потерялось бы, начни негативный список читать хост: тот же
    // издатель, тот же заголовок, но без пути — и строка чистая.
    expect(resolveRowAdverse({ url: "https://x.com/", domain: "x.com", title: "Репост" })).toBe(
      false
    );
  });
});

describe("на самой мягкой площадке поведение прежнее", () => {
  it("«скандалы» в заголовке энциклопедии метки не дают", () => {
    expect(
      resolveRowAdverse({
        url: "https://ru.wikipedia.org/wiki/Кремлёв",
        domain: "ru.wikipedia.org",
        title: WEAK_TITLE,
      })
    ).toBe(false);
  });

  it("«уголовное дело» в заголовке энциклопедии метку дают", () => {
    expect(
      resolveRowAdverse({
        url: "https://ru.wikipedia.org/wiki/Дело",
        domain: "ru.wikipedia.org",
        title: "Уголовное дело против предпринимателя",
      })
    ).toBe(true);
  });
});
