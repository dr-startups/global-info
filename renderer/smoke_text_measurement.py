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

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from orion_golden_render.common import (
    _trim_dangling_tail,  # noqa: E402
    _close_dangling_lead_in,
    _fit_lines_to_height,
    measure_text_height,
)

WIDTH = 8_000_000
SIZE = 10.5

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
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

    print(f"\n{'FAILED (' + str(len(failures)) + ')' if failures else 'PASSED (0 failures)'}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
