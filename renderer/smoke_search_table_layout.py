#!/usr/bin/env python3
"""Смок: ширины колонок и высоты строк клиентских таблиц (`_add_search_table`).

`_add_search_table` — единственный отрисовщик таблиц шаблона
`orion_golden_search_table`, то есть всех таблиц деки, кроме матрицы рисков.
Пропорции колонок выбирались по длине первого заголовка, а не по смыслу:
трёхколоночная таблица тем («Тема | Публикаций | Из них нежелательных»)
отдавала тексту 14 % ширины, а двум счётчикам — 86 %. Высота строки мерилась
по одной колонке, поэтому строка объявлялась в 2–4 раза ниже своего
содержимого.

Растровый смок этого не видит по построению: текст, зажатый в узкую колонку,
переносится и остаётся внутри ячейки, за поля не выходит. Поэтому ширины
проверяются здесь — прямо по геометрии таблицы, которую построил рендерер.

Сеть, база и LibreOffice не нужны: строится презентация в памяти, читаются
`table.columns[i].width` и `table.rows[i].height`.

Запуск: python3 renderer/smoke_search_table_layout.py (нужен python-pptx)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pptx import Presentation  # noqa: E402
from pptx.util import Emu  # noqa: E402

from smoke_counters import print_tap_counters  # noqa: E402
from orion_golden_render.common import (  # noqa: E402
    CONTENT_W,
    EMU_PER_PT,
    SLIDE_H,
    SLIDE_W,
    _Ctx,
)
from orion_golden_render.visual import _add_search_table  # noqa: E402

# Наборы заголовков, которые сегодня посылают построители секций.
HDR_SERP = ["№", "Ссылка", "Заголовок", "Тип источника", "Оценка"]
HDR_THEMES = ["Тема", "Публикаций", "Из них нежелательных"]
HDR_METRICS = ["Система", "Показатель", "Объём", "Комментарий"]
HDR_COMPLIANCE = ["База данных", "Тип совпадения", "Оценка совпадения", "Статус проверки"]
HDR_FALLBACK = ["Поз.", "Домен", "Заголовок", "Риск"]
HDR_PAIR = ["Параметр", "Значение"]

# Тема на предельной длине схемы (`LinkVerdict.theme`, max 120) и адрес на
# предельной длине строителя (`LINK_MAX_CHARS = 62`) — худшие законные случаи.
THEME_120 = (
    "Совместный бизнес с действующим чиновником регионального уровня "
    "и участие в закупках подведомственных учреждений области"
)
LINK_62 = "https://www.kommersant.ru/doc/6721345-o-sdelke-i-partnerah-fo…"
TITLE_SERP = "Как устроена сделка: партнёры, доли и подряды регионального оператора"

# Модель высоты строки таблицы: 10pt, межстрочный 1.2, отбивка 6pt.
BODY_PT = 10.0
LINE_H = int(BODY_PT * EMU_PER_PT * 1.2)
PAD = int(6 * EMU_PER_PT)
CHAR_W_10PT = int(BODY_PT * EMU_PER_PT * 0.52)

failures: list[str] = []

#: Счётчик выполненных проверок — раннер обязан видеть, сколько их было.
passed_checks = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed_checks
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if ok:
        passed_checks += 1
    else:
        failures.append(name)


def build_table(headers: list[str], rows: list[list[str]]) -> Any:
    """Отрисовать таблицу так, как её рисует рендерер, и отдать её геометрию."""
    prs = Presentation()
    prs.slide_width = Emu(SLIDE_W)
    prs.slide_height = Emu(SLIDE_H)
    ctx = _Ctx(prs, 1, 1)
    _add_search_table(ctx, 1_500_000, headers, rows)
    tables = [sh.table for sh in ctx.slide.shapes if getattr(sh, "has_table", False)]
    if len(tables) != 1:
        raise RuntimeError(f"ожидалась одна таблица, получено {len(tables)}")
    return tables[0]


def widths_of(headers: list[str], rows: list[list[str]]) -> list[int]:
    return [int(c.width) for c in build_table(headers, rows).columns]


def shares_of(widths: list[int]) -> list[float]:
    return [w / CONTENT_W for w in widths]


def fmt(widths: list[int]) -> str:
    return ", ".join(f"{w} ({w / CONTENT_W:.3f})" for w in widths)


def main() -> int:
    # --- Т1. Текстовая колонка ведёт таблицу тем ----------------------------
    themes_rows = [[THEME_120, "7", "3"]]
    w_themes = widths_of(HDR_THEMES, themes_rows)
    s_themes = shares_of(w_themes)
    check(
        "Т1а: колонка «Тема» занимает не меньше 55 % ширины",
        s_themes[0] >= 0.55,
        f"доли: {fmt(w_themes)}",
    )
    check(
        "Т1б: колонки-счётчики занимают не больше 22 % каждая",
        max(s_themes[1], s_themes[2]) <= 0.22,
        f"«Публикаций» {s_themes[1]:.3f}, «Из них нежелательных» {s_themes[2]:.3f}",
    )

    # --- Т2. Ссылка уже заголовка, но адрес не рвётся -----------------------
    serp_rows = [["1", LINK_62, TITLE_SERP, "СМИ", "Нежелательный"]]
    w_serp = widths_of(HDR_SERP, serp_rows)
    check(
        "Т2а: «Заголовок» вдвое шире «Ссылки»",
        w_serp[2] >= 2 * w_serp[1],
        f"Заголовок {w_serp[2]}, Ссылка {w_serp[1]}",
    )
    check(
        "Т2б: «Ссылка» не шире 22 % ширины",
        w_serp[1] <= 0.22 * CONTENT_W,
        f"Ссылка {w_serp[1]} ({w_serp[1] / CONTENT_W:.3f})",
    )
    # 62-символьный адрес занимает не больше двух строк, значит в строку модели
    # 10pt должен входить хотя бы 31 символ. Меряется арифметикой ширины, а не
    # `_title_line_estimate`: одиночный токен без пробелов она оценивает в две
    # строки при любой ширине, и проверка через неё была бы тождеством.
    chars_in_link = int(w_serp[1] / CHAR_W_10PT)
    check(
        "Т2в: в колонку «Ссылка» входит ≥31 символа строки 10pt",
        chars_in_link >= 31,
        f"{chars_in_link} символов при ширине {w_serp[1]}",
    )

    # --- Т3. Высота строки — по самой высокой ячейке ------------------------
    themes_table = build_table(HDR_THEMES, themes_rows)
    data_row_h = int(themes_table.rows[1].height)
    check(
        "Т3: строка со 120-символьной темой объявлена не ниже двух строк текста",
        data_row_h >= 2 * LINE_H + PAD,
        f"высота {data_row_h}, нужно ≥ {2 * LINE_H + PAD} (тема {len(THEME_120)} симв.)",
    )

    # --- Т4. Таблицы вне задачи не тронуты ----------------------------------
    # Метрики региона и комплаенс сохраняют сегодняшние доли: их пропорции тоже
    # кривые, но это отдельный пункт бэклога, а не эта правка.
    expected_four = [0.14, 0.26, 0.42, 0.18]
    for label, headers, rows in (
        (
            "метрики региона",
            HDR_METRICS,
            [["Яндекс", "Найдено страниц", "312", "Проверено вручную 20 первых"]],
        ),
        (
            "комплаенс",
            HDR_COMPLIANCE,
            [["OpenSanctions", "Совпадение по имени", "0.71", "Требует проверки"]],
        ),
    ):
        w = widths_of(headers, rows)
        s = shares_of(w)
        ok = len(s) == 4 and all(abs(s[i] - expected_four[i]) <= 0.005 for i in range(4))
        check(
            f"Т4: доли таблицы «{label}» не изменились",
            ok,
            f"{fmt(w)}",
        )

    # --- Т5. Двухколоночная таблица ------------------------------------------
    w_pair = widths_of(HDR_PAIR, [["Регион выдачи", "Российская Федерация"]])
    s_pair = shares_of(w_pair)
    check(
        "Т5: две колонки делятся как 0.24 / 0.76",
        len(s_pair) == 2
        and abs(s_pair[0] - 0.24) <= 0.005
        and abs(s_pair[1] - 0.76) <= 0.005,
        f"{fmt(w_pair)}",
    )

    # --- Т6. Номерная колонка узнаётся по смыслу ------------------------------
    w_fallback = widths_of(HDR_FALLBACK, [["1", "kommersant.ru", TITLE_SERP, "Высокий"]])
    check(
        "Т6: номерная колонка «Поз.» не шире 8 % ширины",
        w_fallback[0] <= 0.08 * CONTENT_W,
        f"«Поз.» {w_fallback[0]} ({w_fallback[0] / CONTENT_W:.3f})",
    )

    # --- Т7. Остаток не теряется и не утекает ---------------------------------
    for label, widths in (
        ("выдача ТОП-20", w_serp),
        ("темы публикаций", w_themes),
        ("метрики региона", widths_of(HDR_METRICS, [["Яндекс", "Найдено страниц", "312", "—"]])),
        (
            "комплаенс",
            widths_of(HDR_COMPLIANCE, [["OpenSanctions", "Имя", "0.71", "Требует проверки"]]),
        ),
        ("запасной разбор", w_fallback),
        ("две колонки", w_pair),
    ):
        total = sum(widths)
        check(
            f"Т7: ширины таблицы «{label}» дают ровно ширину контента",
            total == CONTENT_W,
            f"сумма {total}, ширина контента {CONTENT_W}",
        )

    print(f"\n{'FAILED (' + str(len(failures)) + ')' if failures else 'PASSED (0 failures)'}")
    print_tap_counters(passed=passed_checks, failed=len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
