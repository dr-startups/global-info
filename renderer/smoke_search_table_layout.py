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

import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pptx import Presentation  # noqa: E402
from pptx.util import Emu  # noqa: E402

from smoke_counters import print_tap_counters  # noqa: E402
from orion_golden_render.common import (  # noqa: E402
    CONTENT_W,
    EMU_PER_INCH,
    EMU_PER_PT,
    SLIDE_H,
    SLIDE_W,
    _Ctx,
)
from orion_golden_render.common import (  # noqa: E402
    _wrapped_line_count,
    get_layout_telemetry,
    reset_layout_telemetry,
    text_width_px,
)
from orion_golden_render.visual import (  # noqa: E402
    BADGE_PT,
    CELL_MARGINS_EMU,
    _add_search_table,
    _status_tone,
)
from orion_golden_render.slides import (  # noqa: E402
    SEARCH_TABLE_INTRO_GAP as INTRO_GAP,
    SEARCH_TABLE_INTRO_MAX_H as INTRO_MAX_H,
    _render_slide,
)

# Наборы заголовков, которые сегодня посылают построители секций.
HDR_SERP = ["№", "Заголовок", "Тип источника", "Оценка"]
HDR_THEMES = ["Тема", "Публикаций", "Из них нежелательных"]
HDR_METRICS = ["Система", "Показатель", "Объём", "Комментарий"]
HDR_COMPLIANCE = ["База данных", "Тип совпадения", "Оценка совпадения", "Статус проверки"]
HDR_FALLBACK = ["Поз.", "Домен", "Заголовок", "Риск"]
HDR_PAIR = ["Параметр", "Значение"]

# Тема на предельной длине схемы (`LinkVerdict.theme`, max 120) — худший
# законный случай текстовой колонки таблицы тем.
THEME_120 = (
    "Совместный бизнес с действующим чиновником регионального уровня "
    "и участие в закупках подведомственных учреждений области"
)
TITLE_SERP = "Как устроена сделка: партнёры, доли и подряды регионального оператора"

#: Вывод по теме в том виде, в каком его печатает построитель страницы выдачи.
FOUND_LINE = "«PEP / RCA / watchlist-сигналы» — средний уровень внимания."

# Пределы строителя, повторённые здесь числами: смок питоновский и до TS не
# дотягивается. Заголовок строки — `SERP_TITLE_MAX_CHARS` (`serp.ts`), полоса
# адреса — `ADDRESS_BAND_MAX_CHARS` (`shared.ts`); меняются вместе с этими
# строками. Ёмкость листа читается из самого реестра (см. `serp_capacity`).
SERP_TITLE_MAX_CHARS = 95
ADDRESS_BAND_MAX_CHARS = 240

#: Самый широкий знак 9 pt среди тех, что встречаются в адресах корпуса и в
#: русском тексте («W» 12,10 px, «Ю» 12,15 px). Из него и выведен предел полосы.
WIDEST_GLYPH_PX = text_width_px("Ю" * 20, 9) / 20

#: Худший правдоподобный заголовок строки: 95 знаков русской прозы.
TITLE_95 = "Расследование о деловых связях и зарубежных активах предпринимателя в юрисдикциях Европы сегодня"[
    :SERP_TITLE_MAX_CHARS
]
#: Тот же предел, но с патологическим переносом: три слова, каждое чуть шире
#: половины колонки. Больше двух строк — законно, и объявить их обязаны все три.
TITLE_95_WORST_WRAP = ("Ю" * 31 + " ") * 3
TITLE_95_WORST_WRAP = TITLE_95_WORST_WRAP[:SERP_TITLE_MAX_CHARS]
#: Адрес обычным письмом на предельной длине полосы — две строки.
ADDRESS_BAND_PLAIN = (
    "kompromat1.online/articles/364300-byvshij-partner-oligarhov-usmanova-i-ananeva-stal-"
    "figurantom-dela-o-moshennichestve-v-osobo-krupnom-razmere-podrobnosti-materiala-"
    "prodolzhenie-chast-vtoraya-i-tretya-arhivnaya-kopiya-stranicy-2026-goda-dopolnenie"
)
ADDRESS_BAND_PLAIN = ADDRESS_BAND_PLAIN.ljust(ADDRESS_BAND_MAX_CHARS, "x")[
    :ADDRESS_BAND_MAX_CHARS
]

#: Худший законный адрес полосы — **из корпуса прогона**, а не придуманный:
#: адрес инстаграма с процентно закодированными иероглифами в строке
#: параметров, 280 знаков в корпусе, обрезанный печатником по пределу полосы.
#: Три нарисованные строки, и это рядовой случай: длиннее 163 знаков в корпусе
#: 16 адресов из 243 (правило: уникальный host+path без схемы, www. и якоря).
ADDRESS_BAND_WORST = (
    "instagram.com/p/DWnYkpiinGF?__d=1Bug%E8%BA%AB%E4%BB%BD%E8%AF%81%E6%9F%A5%E6%89%8B%E6%9C%BA"
    "%E5%8F%B7%E7%A4%BE%E4%BF%9D%E5%8D%A1%E5%8F%B7%E6%9F%A5%E8%AF%A2%E5%A7%93%E5%90%8D%E6%9F%A5"
    "%E8%AF%A2%E8%BA%AB%E4%BB%BD%E8%AF%81%E5%8F%B7%E7%A0%81%E6%9F%A5%E8%AF%A2%E4%B8%AA%E4%BA%BA"
)
ADDRESS_BAND_WORST = ADDRESS_BAND_WORST[: ADDRESS_BAND_MAX_CHARS - 1] + "…"
#: Самый длинный полный адрес корпуса прогона 72 — 153 знака после разбора.
ADDRESS_CORPUS_MAX = (
    "kompromat1.online/articles/364300-byvshij_partner_oligarhov_usmanova_i_ananeva_stal_"
    "figurantom_dela_o_moshennichestve_v_osobo_krupnom_razmere_podrobnosti"
)

# Модель высоты строки таблицы: межстрочный 1.2, отбивка 6pt.
#
# Кегль — тот, которым красится ячейка (кегль подписи). Пока высота считалась
# при 10pt, а рисовалась при 9, мера и рисование расходились на ступень шкалы.
SERP_PT = 9.0
SERP_LINE_H = int(SERP_PT * EMU_PER_PT * 1.2)
PAD = int(6 * EMU_PER_PT)

# Самая длинная законная ячейка статуса: у прогона, чей статус проверки в
# артефактах не зафиксирован, печатается именно она.
STATUS_UNRECORDED = "Не подтверждено (статус в артефактах прогона не зафиксирован)"
COMPLIANCE_ROW = ["OpenSanctions", "PEP (политически значимое лицо)", "71/100", STATUS_UNRECORDED]

#: Цвета `_status_tone` по ступеням клиентской шкалы: danger / warn / neutral.
RED_RISK = "B91C1C"
AMBER_OPEN = "C2410C"
SLATE_NEUTRAL = "64748B"

#: Зелёный `_status_tone` по умолчанию — тот самый «всё в порядке».
#: Сравнивается строкой: RGBColor — подкласс tuple, и сравнение с числом
#: всегда ложно, то есть проверка «не зелёный» была бы тождеством.
GREEN_OK = "047857"

#: Поля ячейки python-pptx берутся у самого отрисовщика: второе такое число
#: разошлось бы с ним молча.
EMU_PER_PX = 9525

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


def build_table(
    headers: list[str], rows: list[list[str]], addresses: list[str] | None = None
) -> Any:
    """Отрисовать таблицу так, как её рисует рендерер, и отдать её геометрию."""
    prs = Presentation()
    prs.slide_width = Emu(SLIDE_W)
    prs.slide_height = Emu(SLIDE_H)
    ctx = _Ctx(prs, 1, 1)
    _add_search_table(ctx, 1_500_000, headers, rows, row_addresses=addresses)
    tables = [sh.table for sh in ctx.slide.shapes if getattr(sh, "has_table", False)]
    if len(tables) != 1:
        raise RuntimeError(f"ожидалась одна таблица, получено {len(tables)}")
    return tables[0]


def widths_of(
    headers: list[str], rows: list[list[str]], addresses: list[str] | None = None
) -> list[int]:
    return [int(c.width) for c in build_table(headers, rows, addresses).columns]


def serp_capacity() -> int:
    """Ёмкость листа выдачи — из реестра шаблонов, а не вторым числом здесь.

    Реестр объявлен в TypeScript, поэтому читается сам файл: артефакт приёмки
    отстаёт от кода ровно до следующего прогона ворот, а вопрос «сколько строк
    на листе» обязан иметь один ответ в любой момент.
    """
    registry = (
        Path(__file__).resolve().parent.parent
        / "src/modules/digital-profile/orion-golden/deck-sections/template-registry.ts"
    )
    src = registry.read_text(encoding="utf-8")
    block = re.search(r'"serp-table":\s*\{(.*?)\n  \},', src, re.S)
    if not block:
        raise RuntimeError(f"в {registry.name} не найден блок шаблона serp-table")
    found = re.search(r"maxTableRowsPerSlide:\s*(\d+)", block.group(1))
    if not found:
        raise RuntimeError("в блоке serp-table не найдена maxTableRowsPerSlide")
    return int(found.group(1))


def render_search_table_page(rows: list[list[str]], addresses: list[str], intro: str) -> Any:
    """Отрисовать страницу шаблона `orion_golden_search_table` и отдать её ctx."""
    prs = Presentation()
    prs.slide_width = Emu(SLIDE_W)
    prs.slide_height = Emu(SLIDE_H)
    ctx = _Ctx(prs, 1, 1)
    _render_slide(
        ctx,
        {
            "slideKey": "p09_ru_serp_table",
            "template": "orion_golden_search_table",
            "title": "Россия — Яндекс: собранная выдача (1/4)",
            "narrative": intro,
            "table": {"headers": HDR_SERP, "rows": rows, "rowAddresses": addresses},
        },
        {},
    )
    return ctx


def search_table_page(
    rows: list[list[str]], addresses: list[str], intro: str
) -> tuple[Any, Any]:
    """Страница шаблона `orion_golden_search_table` целиком.

    Возвращает фигуру таблицы и фигуру белой сцены: бюджет листа — низ сцены,
    а не низ слайда, и проверяется он на настоящей странице, а не арифметикой
    по константам.
    """
    ctx = render_search_table_page(rows, addresses, intro)
    table = next((sh for sh in ctx.slide.shapes if getattr(sh, "has_table", False)), None)
    stage = next((sh for sh in ctx.slide.shapes if (sh.name or "").startswith("orion_card_p")), None)
    if table is None or stage is None:
        raise RuntimeError("на странице выдачи нет таблицы или белой сцены")
    return table, stage


def intro_box(ctx: Any) -> Any:
    """Короб вводного абзаца страницы выдачи — по имени, которое даёт `ctx.body`."""
    box = next(
        (sh for sh in ctx.slide.shapes if (sh.name or "").startswith("orion_text_body_p")),
        None,
    )
    if box is None:
        raise RuntimeError("на странице выдачи нет вводного абзаца")
    return box


def intro_font_pt(box: Any) -> float | None:
    """Кегль, которым нарисован абзац: `ctx.body` понижает его, когда не влезло."""
    for para in box.text_frame.paragraphs:
        for run in para.runs:
            if run.font.size is not None:
                return run.font.size.pt
    return None


def shares_of(widths: list[int]) -> list[float]:
    return [w / CONTENT_W for w in widths]


def fmt(widths: list[int]) -> str:
    return ", ".join(f"{w} ({w / CONTENT_W:.3f})" for w in widths)


def usable_px(width_emu: int) -> float:
    """Полезная ширина ячейки в пикселях — так же, как её считает перенос.

    Поля ячейки вычитаются, и берётся тот же запас 0.90, что у
    `_wrapped_line_count`: проверка ширины обязана мерить ту ширину, по которой
    рендерер потом объявит высоту.
    """
    return max(1, width_emu - CELL_MARGINS_EMU) / EMU_PER_INCH * 96 * 0.90


def lines_needed(text: str, width_emu: int, pt: float, bold: bool = False) -> int:
    """Во сколько строк ляжет текст в колонке такой ширины.

    Меряется настоящими метриками шрифта, а не моделью `_title_line_estimate`:
    та упирается в потолок «две строки» и на длинной ячейке отвечает «две»
    всегда — то есть проверка через неё была бы тождеством.
    """
    usable = max(1, width_emu - CELL_MARGINS_EMU)
    lines = 1
    cur = ""
    for word in text.split():
        trial = f"{cur} {word}".strip()
        if text_width_px(trial, pt, bold) * EMU_PER_PX <= usable:
            cur = trial
        else:
            lines += 1
            cur = word
    return lines


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

    # --- Т2. Таблица выдачи: ветка по данным, а не по словам заголовков ------
    #
    # Признак ветки — полосы адреса в самих данных. Разбирать заголовки по
    # именам значит снова угадывать: у запасного разбора первый заголовок тоже
    # номерной («Поз.»), а слово «Заголовок» стоит и там.
    serp_rows = [["1", TITLE_95, "Официальный сайт / госресурс", "Нежелательный"]]
    w_serp = widths_of(HDR_SERP, serp_rows, [ADDRESS_BAND_PLAIN])
    s_serp = shares_of(w_serp)
    check(
        "Т2а: «Заголовок» занимает не меньше 55 % ширины",
        s_serp[1] >= 0.55,
        f"доли: {fmt(w_serp)}",
    )
    check(
        "Т2б: номерная колонка «№» не шире 6 % ширины",
        s_serp[0] <= 0.06,
        f"«№» {w_serp[0]} ({s_serp[0]:.3f})",
    )
    # Ветка выбирается наличием полос: те же самые заголовки без адресов
    # обязаны получить общие доли, иначе признаком снова стало имя колонки.
    s_no_band = shares_of(widths_of(HDR_SERP, serp_rows))
    check(
        "Т2в: те же заголовки без полос адреса идут общей номерной веткой",
        abs(s_no_band[0] - 0.07) <= 0.005 and abs(s_no_band[1] - 0.22) <= 0.005,
        f"без полос: {fmt(widths_of(HDR_SERP, serp_rows))}",
    )
    # --- Т2г. Границы полосы: обычное письмо и худший законный случай --------
    #
    # Предел полосы выведен из ширины: 3 × 998 px / 12,15 px (самый широкий знак
    # 9 pt в письме адресов) = 246 знаков гарантируют три строки; взято 240.
    # WIDEST_GLYPH_PX меряется по шрифту, а не вписан числом, но берётся по
    # письму адресов: `№` (13,1 px) шире, и 240 таких знаков дали бы четыре
    # строки. Ниже закреплены обе границы — иначе вывод ёмкости стоял бы на
    # слове.
    usable_band_px = usable_px(CONTENT_W)
    band_px = text_width_px(ADDRESS_BAND_PLAIN, 9)
    check(
        "Т2г: адрес обычным письмом на пределе полосы — две строки",
        band_px <= 2 * usable_band_px,
        f"{band_px}px при полезной ширине полосы {usable_band_px:.0f}px",
    )
    worst_band_px = text_width_px(ADDRESS_BAND_WORST, 9)
    check(
        "Т2г2: худший законный адрес полосы — не больше трёх строк",
        worst_band_px <= 3 * usable_band_px,
        f"{worst_band_px}px при полезной ширине полосы {usable_band_px:.0f}px",
    )
    check(
        "Т2г3: предел полосы гарантирует три строки письмом адресов",
        ADDRESS_BAND_MAX_CHARS * WIDEST_GLYPH_PX <= 3 * usable_band_px,
        f"{ADDRESS_BAND_MAX_CHARS} × {WIDEST_GLYPH_PX:.2f}px = "
        f"{ADDRESS_BAND_MAX_CHARS * WIDEST_GLYPH_PX:.0f}px при трёх строках "
        f"{3 * usable_band_px:.0f}px",
    )
    title_px = text_width_px(TITLE_95, 9)
    usable_title_px = usable_px(w_serp[1])
    check(
        "Т2д: худший правдоподобный заголовок укладывается в две строки",
        title_px <= 2 * usable_title_px,
        f"{title_px}px при полезной ширине колонки {usable_title_px:.0f}px",
    )
    widest_source_type = "Официальный сайт / госресурс"
    source_px = text_width_px(widest_source_type, 9)
    usable_source_px = usable_px(w_serp[2])
    check(
        "Т2е: самое длинное значение «Тип источника» — одна строка",
        source_px <= usable_source_px,
        f"{source_px}px при полезной ширине {usable_source_px:.0f}px",
    )
    # --- Т2ж. Полоса печатается целиком ---------------------------------------
    serp_table = build_table(HDR_SERP, serp_rows, [ADDRESS_BAND_PLAIN])
    band_cell = serp_table.cell(2, 0)
    check(
        "Т2ж: адрес доезжает до ячейки без реза",
        band_cell.text == ADDRESS_BAND_PLAIN,
        f"в ячейке {len(band_cell.text)} знаков из {len(ADDRESS_BAND_PLAIN)}",
    )
    check(
        "Т2з: полоса адреса идёт во всю ширину контента",
        band_cell.is_merge_origin and band_cell.span_width == len(HDR_SERP),
        f"полоса объединяет {band_cell.span_width} из {len(HDR_SERP)} колонок",
    )
    # --- Т2и. Высота строки без потолка «две строки» ---------------------------
    #
    # `_title_line_estimate` объявляла две строки при любом содержимом: строка
    # в три нарисованных строки объявлялась двумя, LibreOffice тянул её по
    # содержимому, и таблица уезжала ниже поля при «чистой» геометрии.
    worst_wrap = build_table(
        HDR_SERP,
        [["1", TITLE_95_WORST_WRAP, "СМИ", "Нейтральный"]],
        [ADDRESS_CORPUS_MAX],
    )
    worst_row_h = int(worst_wrap.rows[1].height)
    check(
        "Т2и: ячейка в три нарисованных строки объявлена тремя",
        worst_row_h >= 3 * SERP_LINE_H + PAD,
        f"высота {worst_row_h}, нужно ≥ {3 * SERP_LINE_H + PAD}",
    )

    # --- Т3. Высота строки — по самой высокой ячейке ------------------------
    themes_table = build_table(HDR_THEMES, themes_rows)
    data_row_h = int(themes_table.rows[1].height)
    check(
        "Т3: строка со 120-символьной темой объявлена не ниже двух строк текста",
        data_row_h >= 2 * SERP_LINE_H + PAD,
        f"высота {data_row_h}, нужно ≥ {2 * SERP_LINE_H + PAD} (тема {len(THEME_120)} симв.)",
    )

    # --- Т4. Таблицы вне задачи не тронуты ----------------------------------
    # Метрики региона сохраняют сегодняшние доли: их пропорции тоже кривые, но
    # это отдельный пункт бэклога, а не эта правка.
    expected_four = [0.14, 0.26, 0.42, 0.18]
    for label, headers, rows in (
        (
            "метрики региона",
            HDR_METRICS,
            [["Яндекс", "Найдено страниц", "312", "Проверено вручную 20 первых"]],
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

    # --- Т8. Комплаенс-сводка: своя ветка долей -------------------------------
    # Общая четырёхколоночная ветка отдавала «Оценке совпадения» 42 % под
    # «78/100», а «Статусу проверки» — 18 % под строку из шести слов. Доли
    # выверены настоящими метриками шрифта: самая длинная законная ячейка
    # статуса — «Не подтверждено (статус в артефактах прогона не зафиксирован)».
    w_comp = widths_of(HDR_COMPLIANCE, [COMPLIANCE_ROW])
    s_comp = shares_of(w_comp)
    expected_compliance = [0.16, 0.30, 0.18, 0.36]
    check(
        "Т8а: доли комплаенс-сводки — своя ветка 0.16 / 0.30 / 0.18 / 0.36",
        len(s_comp) == 4
        and all(abs(s_comp[i] - expected_compliance[i]) <= 0.005 for i in range(4)),
        f"{fmt(w_comp)}",
    )
    check(
        "Т8б: «Статус проверки» шире «Оценки совпадения»",
        w_comp[3] > w_comp[2],
        f"статус {w_comp[3]}, оценка {w_comp[2]}",
    )
    # Строка статуса рисуется бейджем: «● » впереди и кегль 9.5.
    status_lines = lines_needed(f"● {STATUS_UNRECORDED}", w_comp[3], 9.5)
    check(
        "Т8в: самая длинная законная ячейка статуса укладывается в две строки",
        status_lines <= 2,
        f"{status_lines} строк(и) при ширине {w_comp[3]}",
    )
    for i, (label, text, bold) in enumerate(
        (
            ("База данных", "OpenSanctions", False),
            ("Тип совпадения", "Импортированный отчёт LexisNexis", False),
            ("Оценка совпадения", HDR_COMPLIANCE[2], True),
        )
    ):
        n = lines_needed(text, w_comp[i], 10.0, bold)
        check(
            f"Т8г: колонка «{label}» держит «{text}» в одну строку",
            n == 1,
            f"{n} строк(и) при ширине {w_comp[i]}",
        )

    # --- Т9. Бейдж статуса ----------------------------------------------------
    # Незнакомое слово в `_status_tone` зелёное по умолчанию, и подтверждённый
    # комплаенс-риск рисовался цветом «всё в порядке».
    _, tone_confirmed = _status_tone("Подтверждено аналитиком")
    check(
        "Т9а: «Подтверждено аналитиком» — не зелёный бейдж",
        str(tone_confirmed) != GREEN_OK,
        f"цвет {tone_confirmed}",
    )
    _, tone_unrecorded = _status_tone(STATUS_UNRECORDED)
    check(
        "Т9б: незафиксированный статус — не зелёный бейдж",
        str(tone_unrecorded) != GREEN_OK,
        f"цвет {tone_unrecorded}",
    )
    # Клиентская шкала печатает три слова, и бейдж обязан их знать: незнакомое
    # слово здесь зелёное по умолчанию, то есть «Высокий» читался бы как «всё в
    # порядке».
    steps = {word: str(_status_tone(word)[1]) for word in ("Высокий", "Средний", "Низкий")}
    check(
        "Т9в: ступени шкалы не зелёные",
        all(colour != GREEN_OK for colour in steps.values()),
        f"цвета {steps}",
    )
    check(
        "Т9г: цвет ступени растёт вместе со ступенью",
        steps["Высокий"] == RED_RISK and steps["Средний"] == AMBER_OPEN and steps["Низкий"] == SLATE_NEUTRAL,
        f"цвета {steps}",
    )

    # Зелёный — цвет явного «всё в порядке», и достаться он должен только
    # слову, которое это значит. Незнакомое слово зелёным быть не может:
    # статус, которого функция не знает, — не благополучие, а неизвестность, и
    # в документе для банка он читался бы как одобрение. Живой прогон 22.08:
    # все шесть встреченных значений попали в названные ветки, то есть зелёный
    # достижим сегодня **только** незнакомым словом (пункт V).
    unknown = {
        word: str(_status_tone(word)[1])
        for word in ("Проверено", "Совпадений не найдено", "Ожидает выгрузки", "Clean")
    }
    check(
        "Т9д: незнакомый статус не зелёный",
        all(colour != GREEN_OK for colour in unknown.values()),
        f"цвета {unknown}",
    )
    # У зелёного есть законный владелец: «Позитивный» стоит в легенде таблицы.
    # Пока он доставался по умолчанию, легенда обещала маркер, которого функция
    # не знала по имени.
    _, tone_positive = _status_tone("Позитивный")
    check(
        "Т9е: «Позитивный» — зелёный по имени, а не по умолчанию",
        str(tone_positive) == GREEN_OK,
        f"цвет {tone_positive}",
    )

    # --- Т10. Подсветка строки — только от статусной колонки ------------------
    # В карточке записи последняя колонка называется «Значение». Пока подсветка
    # смотрела на её текст, янтарь доставался строке «Категория: Требует ручной
    # классификации», а строка настоящего статуса оставалась белой.
    card = build_table(
        HDR_PAIR,
        [
            ["Совпадение по имени", "Глинка Сергей Михайлович"],
            ["Категория", "Требует ручной классификации"],
            ["Статус проверки", STATUS_UNRECORDED],
        ],
    )
    card_fills = {str(card.cell(r, 1).fill.fore_color.rgb) for r in range(1, 4)}
    check(
        "Т10а: строки карточки записи не подсвечиваются по колонке «Значение»",
        card_fills == {"FFFFFF"},
        f"фоны строк: {sorted(card_fills)}",
    )
    serp = build_table(
        HDR_SERP, [["1", TITLE_SERP, "СМИ", "Нежелательный"]], [ADDRESS_CORPUS_MAX]
    )
    check(
        "Т10б: нежелательная строка выдачи подсветку сохраняет",
        str(serp.cell(1, 1).fill.fore_color.rgb) != "FFFFFF",
        f"фон строки: {serp.cell(1, 1).fill.fore_color.rgb}",
    )

    # --- Т11. Ёмкость листа выдачи и контрольный дефект ----------------------
    #
    # Меры таблиц у рендерера нет, поэтому ёмкость выведена из бюджета листа и
    # худшей законной пары «строка результата + полоса адреса». Арифметика
    # считается по **объявленному** верху таблицы: заголовок страницы плюс
    # потолок вводного абзаца (`SEARCH_TABLE_INTRO_MAX_H`, читается из
    # `slides.py`) плюс отбивка. Считать от фактического верха нельзя — он
    # зависит от длины абзаца и замолчит ровно тогда, когда нужен.
    #
    # Все слагаемые меряются самим рендерером, а не повторяются здесь числами:
    # низ заголовка — верх таблицы на странице без абзаца; высота шапки и пары
    # — строки настоящей таблицы; низ бюджета — низ белой сцены.
    capacity = serp_capacity()
    worst_row = [str(1), TITLE_95, "Официальный сайт / госресурс", "Нежелательный"]
    bare_table, stage_shape = search_table_page([worst_row], [ADDRESS_BAND_WORST], "")
    stage_bottom = int(stage_shape.top) + int(stage_shape.height)
    title_bottom = int(bare_table.top)
    declared_top = title_bottom + INTRO_MAX_H + INTRO_GAP
    header_h = int(bare_table.table.rows[0].height)
    row_h = int(bare_table.table.rows[1].height)
    band_h = int(bare_table.table.rows[2].height)
    pair_h = row_h + band_h
    budget = stage_bottom - declared_top - header_h
    # Пара берётся **корпусная**: заголовок предельной длины — две строки,
    # полоса предельной длины — три. Двухстрочная полоса была бы правдоподобной,
    # но не законной: гарантия двух строк требует предела 164 знака, а в корпусе
    # прогона 16 адресов длиннее 163, и шесть из них обычные адреса статей.
    check(
        "Т11а: худшая законная пара — две строки заголовка и три полосы",
        row_h == 2 * SERP_LINE_H + PAD and band_h == 3 * SERP_LINE_H + PAD,
        f"строка {row_h} (ожидалось {2 * SERP_LINE_H + PAD}), "
        f"полоса {band_h} (ожидалось {3 * SERP_LINE_H + PAD})",
    )
    check(
        f"Т11б: {capacity} худших пар влезают в бюджет объявленного листа",
        capacity * pair_h <= budget,
        f"нужно {capacity * pair_h}, бюджет {budget} (низ сцены {stage_bottom}, "
        f"объявленный верх таблицы {declared_top}, шапка {header_h})",
    )
    check(
        f"Т11в: контрольный дефект — {capacity + 1} пар в бюджет не влезают",
        (capacity + 1) * pair_h > budget,
        f"нужно {(capacity + 1) * pair_h}, бюджет {budget}",
    )
    # Второй свидетель: настоящая страница с заведомо переполняющим абзацем.
    # Её верх обязан быть не ниже объявленного потолка — иначе это не потолок,
    # а ёмкость листа, выведенная от него, ничем не держится. Счётчика
    # предложений в шаблоне больше нет, поэтому абзац подаётся заведомо
    # длиннее любого законного: за `max_h` не может выйти и он.
    intro = " ".join(
        [
            f"Предложение номер {n} этого абзаца написано нарочно длинным, чтобы "
            "вводный текст страницы заведомо не поместился в объявленный потолок "
            "и упёрся в него мерой, а не счётчиком предложений."
            for n in range(1, 13)
        ]
    )
    real_table, real_stage = search_table_page(
        [worst_row] * capacity, [ADDRESS_BAND_WORST] * capacity, intro
    )
    check(
        "Т11г: фактический верх таблицы не ниже объявленного потолка",
        int(real_table.top) <= declared_top,
        f"фактический {real_table.top}, объявленный {declared_top}",
    )
    check(
        "Т11д: настоящая страница из худших пар кончается не ниже низа сцены",
        int(real_table.top) + int(real_table.height)
        <= int(real_stage.top) + int(real_stage.height),
        f"низ таблицы {int(real_table.top) + int(real_table.height)}, "
        f"низ сцены {int(real_stage.top) + int(real_stage.height)}",
    )

    # --- Т11е/Т11ж. Абзац страницы выдачи нарисован целиком ------------------
    #
    # Составы собраны из того, что печатают сами построители, и подаются одной
    # строкой — ровно так их видит `ctx.body` (`_safe` схлопывает переводы
    # строк). Проверяется текст листа, а не мера: вопрос «напечаталось ли»
    # задан не тому, кто резал.
    LEAD = "Показана выдача Яндекса по запросу «Глинка Сергей Михайлович»."
    MISSING = (
        "Позиции 1–3, 5, 11–20 в собранных данных отсутствуют: эти строки потеряны "
        "при сборе, а не пусты в выдаче."
    )
    QUERIES = (
        "Выдача проверена по 5 запросам: «глинка сергей михайлович», "
        "«глинка сергей михайлович отзывы», «глинка сергей михайлович компромат», "
        "«глинка сергей михайлович суд», «глинка сергей михайлович бизнес»."
    )
    WHY = (
        "На странице 1 тема повышенного внимания — эти материалы видны при первой же "
        "проверке субъекта."
    )
    TAIL = "Запросить первичные карточки баз и подтвердить принадлежность совпадений."

    # Живой состав страницы выдачи: корпусный плюс два предложения, которых нет
    # на эталоне (там запрос выдачи в артефактах не записан) — о пропущенных
    # позициях и о наборе запросов прогона. Кегль здесь и есть цена потолка: на
    # 900 000 этот же абзац рисуется девяткой, и соседние листы деки поехали бы
    # разным кеглем.
    live_intro = " ".join([LEAD, MISSING, FOUND_LINE, QUERIES, WHY, TAIL])
    live_box = intro_box(
        render_search_table_page([worst_row] * 2, [ADDRESS_BAND_WORST] * 2, live_intro)
    )
    live_text = live_box.text_frame.text
    check(
        "Т11е1: живой состав абзаца страницы выдачи нарисован целиком",
        "подтвердить принадлежность совпадений" in live_text,
        f"нарисовано {len(live_text)} из {len(live_intro)} знаков: {live_text[-100:]!r}",
    )
    check(
        "Т11е2: живой состав нарисован основным кеглем 11 pt",
        intro_font_pt(live_box) == 11,
        f"кегль {intro_font_pt(live_box)} на {len(live_intro)} знаках",
    )

    # Худший состав по **схемным пределам**, а не по корпусу: тема на пределе
    # `LinkVerdict.theme` (120 знаков) и рекомендация на клампе `whatToCheck`
    # (220). Кегль здесь уже девятка — это известно и объявлено; терять
    # предложения абзац по-прежнему не вправе.
    worst_intro = " ".join(
        [
            LEAD,
            MISSING,
            f"«{THEME_120}» — высокий уровень внимания.",
            QUERIES,
            WHY,
            (
                "Запросить первичные карточки баз, подтвердить принадлежность совпадений "
                "по идентификаторам субъекта, сверить заголовки публикаций с "
                "первоисточниками и зафиксировать результат сверки в карточке проверки."
            ),
        ]
    )
    worst_text = intro_box(
        render_search_table_page([worst_row] * 2, [ADDRESS_BAND_WORST] * 2, worst_intro)
    ).text_frame.text
    check(
        "Т11ж: состав по схемным пределам нарисован целиком",
        "зафиксировать результат сверки в карточке проверки" in worst_text,
        f"нарисовано {len(worst_text)} из {len(worst_intro)} знаков: {worst_text[-100:]!r}",
    )

    # --- Т12. Полоса наследует фон своей строки ------------------------------
    #
    # Подсветка строки — знак для проверяющего: он сканирует страницу по
    # красному. Белая полоса разрезает красную плашку пополам, и адрес того
    # самого нежелательного материала оказывается вне красного, зрительно
    # примыкая к следующей, нейтральной строке.
    tinted = build_table(
        HDR_SERP,
        [
            ["1", TITLE_SERP, "СМИ", "Нежелательный"],
            ["2", TITLE_SERP, "СМИ", "Вероятно"],
            ["3", TITLE_SERP, "СМИ", "Нейтральный"],
        ],
        [ADDRESS_CORPUS_MAX] * 3,
    )
    band_fills = [str(tinted.cell(r, 0).fill.fore_color.rgb) for r in (2, 4, 6)]
    row_fills = [str(tinted.cell(r, 1).fill.fore_color.rgb) for r in (1, 3, 5)]
    check(
        "Т12: фон полосы адреса совпадает с фоном своей строки",
        band_fills == row_fills,
        f"полосы {band_fills}, строки {row_fills}",
    )

    # --- Т13. Мера ячейки совпадает с тем, что в ней нарисовано --------------
    #
    # Бейдж красится как «● Нежелательный», а мерился по «Нежелательный» —
    # на два знака короче. Та же щель «мерим одно, рисуем другое», которую
    # закрыли в остальных колонках.
    # Контрольная строка подобрана по метрикам шрифта: без точки 130 px (одна
    # строка колонки оценки), с точкой 146 px при полезных 145 — две. Всё
    # остальное на странице заведомо ниже, чтобы высоту решал именно бейдж.
    BOUNDARY_STATUS = "проверки аналитика"
    badge_table = build_table(
        HDR_SERP, [["1", "Кратко", "СМИ", BOUNDARY_STATUS]], ["a.example.org/1"]
    )
    badge_cell = badge_table.cell(1, 3)
    # Меряем **нарисованное**: тем же переносом, которым рендерер объявляет
    # высоту, и по тексту ячейки, а не по значению из строки.
    badge_lines = _wrapped_line_count(
        badge_cell.text, int(badge_table.columns[3].width) - CELL_MARGINS_EMU, BADGE_PT
    )
    check(
        "Т13: строка объявлена не ниже, чем требует нарисованный бейдж",
        int(badge_table.rows[1].height) >= badge_lines * int(BADGE_PT * EMU_PER_PT * 1.2) + PAD,
        f"высота {badge_table.rows[1].height}, бейджу «{badge_cell.text}» нужно "
        f"{badge_lines} строк(и) по {int(BADGE_PT * EMU_PER_PT * 1.2)}",
    )

    # --- Т14. Пятиколоночная таблица с полосами не роняет рендерер -----------
    #
    # Ветка долей выбирается наличием полос, а `slides.py` пропускает до пяти
    # заголовков: пока условия были разъединены, пятая колонка получала долю из
    # четырёхэлементного списка и `IndexError` ронял всю страницу.
    try:
        five = build_table(
            ["№", "Ссылка", "Заголовок", "Тип источника", "Оценка"],
            [["1", "example.org/1", TITLE_SERP, "СМИ", "Нейтральный"]],
            [ADDRESS_CORPUS_MAX],
        )
        five_ok = len(list(five.columns)) == 5
        five_detail = f"долей {len(list(five.columns))}"
    except Exception as exc:  # noqa: BLE001
        five_ok = False
        five_detail = f"{type(exc).__name__}: {exc}"
    check("Т14: пять колонок с полосами адреса рисуются без отказа", five_ok, five_detail)

    # --- Т15. Бюджет листа объявляется только тогда, когда он известен -------
    #
    # `content_stage` возвращает низ сцены, а при отказе рисовать — свой вход.
    # Одно значение на два вопроса: поданное как бюджет, сентинельное значение
    # даёт ложный CRITICAL с нулевым запасом.
    reset_layout_telemetry()
    build_table(HDR_SERP, [worst_row], [ADDRESS_BAND_PLAIN])
    check(
        "Т15а: без объявленного бюджета таблица о переполнении не заявляет",
        get_layout_telemetry() == [],
        f"записей телеметрии {len(get_layout_telemetry())}",
    )
    reset_layout_telemetry()
    prs = Presentation()
    prs.slide_width = Emu(SLIDE_W)
    prs.slide_height = Emu(SLIDE_H)
    ctx = _Ctx(prs, 1, 1)
    _add_search_table(
        ctx, 1_500_000, HDR_SERP, [worst_row] * 20, row_addresses=[ADDRESS_BAND_PLAIN] * 20,
        bottom=2_000_000,
    )
    entries = get_layout_telemetry()
    check(
        "Т15б: превышение объявленного бюджета слышно записью разметки",
        len(entries) == 1 and entries[0].get("clipped") is True and entries[0]["role"] == "table",
        f"записей {len(entries)}: {entries[:1]}",
    )
    reset_layout_telemetry()

    print(f"\n{'FAILED (' + str(len(failures)) + ')' if failures else 'PASSED (0 failures)'}")
    print_tap_counters(passed=passed_checks, failed=len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
