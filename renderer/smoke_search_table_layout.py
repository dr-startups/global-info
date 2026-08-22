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
from orion_golden_render.common import text_width_px  # noqa: E402
from orion_golden_render.visual import _add_search_table, _status_tone  # noqa: E402

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

#: Поля ячейки python-pptx: по 0.1″ с каждой стороны.
CELL_MARGINS_EMU = 2 * 91_440
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
    serp = build_table(HDR_SERP, [["1", LINK_62, TITLE_SERP, "СМИ", "Нежелательный"]])
    check(
        "Т10б: нежелательная строка выдачи подсветку сохраняет",
        str(serp.cell(1, 1).fill.fore_color.rgb) != "FFFFFF",
        f"фон строки: {serp.cell(1, 1).fill.fore_color.rgb}",
    )

    print(f"\n{'FAILED (' + str(len(failures)) + ')' if failures else 'PASSED (0 failures)'}")
    print_tap_counters(passed=passed_checks, failed=len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
