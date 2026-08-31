/**
 * Ключ материала: адрес решает, заголовок — запасной.
 *
 * Провайдер обрезает заголовок как хочет: на `report-72` один адрес
 * `argumenti.ru/society/2025/05/951674` лежал в индексе пятью ключами, и
 * главная таблица отчёта печатала шесть страниц по два раза. Обратной беды —
 * чтобы общий заголовок склеил две разные страницы — на том же корпусе не
 * нашлось ни одной, поэтому у записи с настоящим `http(s)`-адресом ключ
 * считается по адресу. Заголовок остаётся только там, где настоящего адреса
 * нет: у подсказок и ИИ-ответов псевдоадрес (`arsenkin://…`) несёт хеш запроса,
 * а материалом служит сама фраза.
 */

import { describe, expect, it } from "vitest";
import { serpMaterialKey } from "@/modules/digital-profile/serp-observation/material-key";

describe("ключ материала предпочитает адрес", () => {
  it("один адрес с по-разному обрезанными заголовками — один ключ", () => {
    // Форма `argumenti.ru/society/2025/05/951674` из report-72: пять записей
    // одного адреса, различие — только в месте обрезки заголовка.
    const url = "https://argumenti.ru/society/2025/05/951674";
    const keys = new Set(
      [
        "Бизнесмен Сергей Глинка - биография, личная жизнь и взгляд на...",
        "Бизнесмен Сергей Глинка - биография, личная жизнь...",
        "Бизнесмен Сергей Глинка - биография...",
        "Бизнесмен Сергей Глинка",
        "argumenti.ru",
      ].map((title) => serpMaterialKey({ url, domain: "argumenti.ru", title }))
    );
    expect(keys.size).toBe(1);
  });

  it("две разные страницы одного домена с одинаковым заголовком — разные ключи", () => {
    // Форма «pad»-строк золотого кейса: pravo-obzor.ru/…-20 и …-80 различаются
    // только адресом.
    const a = serpMaterialKey({
      url: "https://pravo-obzor.ru/delo-20",
      domain: "pravo-obzor.ru",
      title: "Обзор дела",
    });
    const b = serpMaterialKey({
      url: "https://pravo-obzor.ru/delo-80",
      domain: "pravo-obzor.ru",
      title: "Обзор дела",
    });
    expect(a).not.toBe(b);
  });

  it("заголовок-адрес и настоящий заголовок одного адреса — один ключ", () => {
    // Форма `techcult.ru`/`labyrinth.ru`/`utro.ru`/`x.com` из report-72: у части
    // записей заголовком служит сам адрес.
    const url = "https://www.techcult.ru/promo/15800-biografiya-biznesmena";
    expect(
      serpMaterialKey({ url, domain: "techcult.ru", title: "techcult.ru/promo/15800-biografiya-biznesmena" })
    ).toBe(serpMaterialKey({ url, domain: "techcult.ru", title: "Биография бизнесмена: фото и проекты" }));
  });

  it("схема в верхнем регистре — всё ещё адрес", () => {
    // Ревью 0038/6: без регистронезависимой проверки запись «HTTPS://…» ушла бы
    // в заголовочную ветку и разъехалась бы со своими близнецами — ровно тот
    // дефект, который правка сняла.
    expect(
      serpMaterialKey({ url: "HTTPS://Argumenti.ru/society/2025/05/951674", title: "Бизнесмен Сергей Глинка" })
    ).toBe(
      serpMaterialKey({ url: "https://argumenti.ru/society/2025/05/951674", title: "Бизнесмен Сергей Глинка - биография..." })
    );
  });

  it("псевдоадрес в ключе не участвует: подсказки сводит фраза", () => {
    // У `arsenkin://suggest/<hash>` хеш свой на каждый запрос; адресный ключ
    // напечатал бы одну и ту же подсказку дважды.
    expect(
      serpMaterialKey({ url: "arsenkin://suggest/49603778fcf9", title: "глинка сергей михайлович" })
    ).toBe(serpMaterialKey({ url: "arsenkin://suggest/db80d4d33ac1", title: "глинка сергей михайлович" }));
  });

  it("метка отслеживания ключ не делит: ?shem= и без — один ключ", () => {
    /*
     * Прежнее решение владельца («список меток один и живёт в слое сбора,
     * второго здесь не заводим») отменено партией 0042: список по-прежнему
     * один, но лежит листовым модулем, и читают его оба слоя. Кириллица в пути
     * при этом остаётся кириллицей — перекодировка снова разделила бы адрес с
     * меткой и без.
     */
    const title = "Глинка Сергей Михайлович";
    expect(
      serpMaterialKey({ url: "https://www.tadviser.ru/index.php/Персона?shem=rimspwouoe,", title })
    ).toBe(serpMaterialKey({ url: "https://www.tadviser.ru/index.php/Персона", title }));
  });
});
