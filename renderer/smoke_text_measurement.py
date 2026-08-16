#!/usr/bin/env python3
"""Смок: замер высоты текста в рендерере (шаг 13, D1).

Многострочная карточка мерилась как один абзац: `_safe` схлопывает любые
пробелы, включая переводы строк, поэтому строки «упаковывались» плотнее, чем
рисуются. Высота выходила заниженной, и текст вылезал за карточку, перекрываясь
следующей. На отчёте это давало восемь блоков ниже границы контента.

Сеть и БД не нужны: проверяются чистые функции разметки.

Запуск: python3 renderer/smoke_text_measurement.py (нужны зависимости рендерера)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from smoke_counters import print_tap_counters  # noqa: E402
from orion_golden_render.common import (
    _trim_dangling_tail,  # noqa: E402
    _close_dangling_lead_in,
    _fit_lines_to_height,
    _bullet_line_style,
    _font_path,
    assert_render_font_family,
    measure_text_height,
    text_width_px,
)

WIDTH = 8_000_000
SIZE = 10.5

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


def main() -> int:
    one_line = "Найдены материалы о политической и публичной экспозиции субъекта"
    three_lines = "\n".join([one_line, one_line, one_line])

    h_one = measure_text_height(one_line, WIDTH, SIZE)
    h_three = measure_text_height(three_lines, WIDTH, SIZE)
    check(
        "многострочный текст выше однострочного",
        h_three > h_one * 2.5,
        f"1 строка {h_one}, 3 строки {h_three}",
    )

    flat = " ".join([one_line, one_line, one_line])
    check(
        "переводы строк не схлопываются в один абзац",
        measure_text_height(three_lines, WIDTH, SIZE) > measure_text_height(flat, WIDTH, SIZE),
        "иначе высота карточки занижается и текст вылезает за неё",
    )

    budget = int(h_one * 2.2)
    fitted = _fit_lines_to_height(three_lines, WIDTH, SIZE, budget)
    check(
        "лишние строки отбрасываются целиком",
        fitted.count("\n") < three_lines.count("\n") and fitted.split("\n")[0] == one_line,
        f"осталось строк: {len(fitted.split(chr(10)))}",
    )
    check(
        "первая строка сохраняется даже при нулевом бюджете",
        _fit_lines_to_height(three_lines, WIDTH, SIZE, 1) == one_line,
    )

    check(
        "повисшее двоеточие закрывается точкой",
        _close_dangling_lead_in("Материал найден в выборке (suggestion):").endswith("."),
    )
    check(
        "короткий ввод без продолжения выбрасывается",
        _close_dangling_lead_in("Тема. Факт.\nНайдены публикации:") == "Тема. Факт.",
    )

    # Шаг 15, E3: многоточие поисковой системы — маркер обрезки заголовка.
    # Прежний разбор оставлял от «Telegram...» одну точку, и обрубок читался
    # как законченная мысль.
    check(
        "многоточие обрезки не превращается в точку",
        _trim_dangling_tail("Как Павел Дуров создал «ВКонтакте», Telegram и стал...")
        == "Как Павел Дуров создал «ВКонтакте», Telegram и стал…",
    )
    check(
        "многоточие с пробелом перед ним тоже сохраняется",
        _trim_dangling_tail("Дуров Павел Валерьевич | биография и последние ...").endswith("…"),
    )
    check(
        "готовый заголовок с точкой не трогается",
        _trim_dangling_tail("Полная биография Павла Дурова: где он живет.")
        == "Полная биография Павла Дурова: где он живет.",
    )
    check(
        "заголовок без конечной пунктуации не получает её",
        _trim_dangling_tail("Дуров, Павел Валерьевич — Википедия")
        == "Дуров, Павел Валерьевич — Википедия",
    )

    # --- меряем тем начертанием, которым рисуем -----------------------------
    #
    # `_font_path()` отдавал единственный DejaVuSans.ttf на все случаи, а
    # жирность ставится через python-pptx (`run.font.bold = True`) в двадцати
    # трёх местах: ширина считалась обычным начертанием, рисовалось жирное —
    # оно шире. Это и есть «текст выезжает за блоки».
    bold_sample = "Криминальные / судебные материалы"
    w_regular = text_width_px(bold_sample, 22, bold=False)
    w_bold = text_width_px(bold_sample, 22, bold=True)
    check(
        "жирное начертание меряется шире обычного",
        w_bold > w_regular,
        f"обычным {w_regular}px, жирным {w_bold}px "
        f"(+{(w_bold - w_regular) / w_regular * 100:.1f}%)",
    )

    # Ширина, на которой лишние проценты дают лишний перенос: именно так
    # заниженный замер выпускает текст за рамку.
    # Ширина не зашивается числом: у разных гарнитур жирное шире по-разному
    # (DejaVu ~10%, Inter ~3,6%), и подобранная под одну ширина на другой
    # перестаёт давать лишний перенос. Свойство же остаётся тем же — найдётся
    # ширина, на которой жирное требует больше высоты. Тест держит свойство.
    wrap_sample = "Криминальные и судебные материалы по проверяемому лицу за последние три года"
    found = next(
        (
            (w, measure_text_height(wrap_sample, w, 13), measure_text_height(wrap_sample, w, 13, bold=True))
            for w in range(700_000, 6_000_001, 50_000)
            if measure_text_height(wrap_sample, w, 13, bold=True)
            > measure_text_height(wrap_sample, w, 13)
        ),
        None,
    )
    check(
        "есть ширина, на которой жирный текст требует больше высоты",
        found is not None,
        f"ширина {found[0]}: обычным {found[1]}, жирным {found[2]}" if found else "не найдено",
    )

    check(
        "оба начертания доступны рендереру",
        _font_path(False) is not None and _font_path(True) is not None,
        f"regular={_font_path(False)}, bold={_font_path(True)}",
    )
    check(
        "начертания — разные файлы, а не один на оба случая",
        _font_path(False) != _font_path(True),
    )

    # Отсутствие шрифта — отказ, а не приблизительный расчёт по числу символов.
    # Прежде ширина бралась как len(text) * size * 0.58: для пропорционального
    # шрифта это неверно всегда, а на «шжм» ошибка кратная — и молча.
    missing = os.environ.get("ORION_RENDER_FONT")
    try:
        os.environ["ORION_RENDER_FONT"] = "/nonexistent/font.ttf"
        import orion_golden_render.common as _c

        real_files = _c._FONT_FILES
        _c._FONT_FILES = {False: "НетТакогоФайла.ttf", True: "НетТакогоФайла-Bold.ttf"}
        try:
            text_width_px("проверка", 11)
            check("нет шрифта — явная ошибка, а не расчёт наугад", False, "ошибки не было")
        except RuntimeError as exc:
            check(
                "нет шрифта — явная ошибка, а не расчёт наугад",
                "font missing" in str(exc),
                str(exc)[:80],
            )
        try:
            assert_render_font_family()
            check("старт валится, когда начертания нет", False, "старт прошёл")
        except RuntimeError:
            check("старт валится, когда начертания нет", True)
        finally:
            _c._FONT_FILES = real_files
    finally:
        if missing is None:
            os.environ.pop("ORION_RENDER_FONT", None)
        else:
            os.environ["ORION_RENDER_FONT"] = missing

    check("старт проходит на исправном составе шрифтов", bool(assert_render_font_family()))

    # --- начертание доезжает до мест замера --------------------------------
    #
    # `_bullet_block_height` вычислял признак жирности и выбрасывал его
    # (`_, _, size_pt`), а рисование в 73 строках ниже тот же признак
    # использовало. Заголовок темы рисовался жирным, мерился обычным.
    theme_line = "Криминальные / судебные материалы:"
    bold_flag, _color, size_pt = _bullet_line_style(theme_line, is_first=True)
    check(
        "строка-заголовок темы объявлена жирной",
        bold_flag is True,
        f"стиль: bold={bold_flag}, size={size_pt}",
    )
    plain_flag, _c2, _s2 = _bullet_line_style("Обычная строка доказательства.", is_first=False)
    check("обычная строка не объявлена жирной", plain_flag is False)

    # Замер обязан различать эти два случая, иначе признак некуда применять.
    # Ширина взята та, на которой лишние проценты дают лишний перенос: на
    # широкой колонке короткая строка влезает и так и так, и проверка была бы
    # тождеством, а не гейтом.
    long_theme = "Криминальные и судебные материалы по проверяемому лицу за последние три года:"
    theme_found = next(
        (
            (w, measure_text_height(long_theme, w, size_pt), measure_text_height(long_theme, w, size_pt, bold=True))
            for w in range(700_000, 6_000_001, 50_000)
            if measure_text_height(long_theme, w, size_pt, bold=True)
            > measure_text_height(long_theme, w, size_pt)
        ),
        None,
    )
    check(
        "заголовок темы жирным где-то требует больше высоты",
        theme_found is not None,
        f"ширина {theme_found[0]}: обычным {theme_found[1]}, жирным {theme_found[2]}"
        if theme_found
        else "не найдено",
    )

    # Проводка: признак начертания обязан доехать до замера, а не быть
    # вычисленным и выброшенным. Именно так он и терялся — `_, _, size_pt` на
    # замере против `bold, line_color, size_pt` на рисовании, в одном файле, в
    # семидесяти строках друг от друга. Проверяется по исходнику, потому что
    # `_bullet_block_height` — замыкание внутри `body()` и снаружи не вызывается.
    common_src = (Path(__file__).resolve().parent / "orion_golden_render" / "common.py").read_text(
        encoding="utf-8"
    )
    measure_sites = [
        ln.strip()
        for ln in common_src.splitlines()
        if "_bullet_line_style(" in ln and "def " not in ln
    ]
    check(
        "признак начертания не выбрасывается ни на одном месте использования",
        measure_sites and all(not ln.startswith("_, _,") for ln in measure_sites),
        f"мест: {len(measure_sites)}",
    )
    check(
        "высота карточки считается по жирному заголовку",
        "line_spacing=1.15, bold=True" in common_src,
        "content_card: заголовок рисуется жирным",
    )
    exec_src = (Path(__file__).resolve().parent / "orion_golden_render" / "executive.py").read_text(
        encoding="utf-8"
    )
    check(
        "заголовок карточки риска меряется жирным",
        "measure_text_height(headline, text_w, 13, line_spacing=1.15, bold=True)" in exec_src,
    )


    print(f"\n{'FAILED (' + str(len(failures)) + ')' if failures else 'PASSED (0 failures)'}")
    print_tap_counters(passed=passed_checks, failed=len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
