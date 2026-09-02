#!/usr/bin/env python3
"""Смок: мерный прогон согласен с отрисовкой, слышит всё и следов не оставляет.

Ёмкость страницы знает только код отрисовки. Мерный прогон (`/orion/measure-layout`)
рисует ту же деку в память и отчитывается по каждой странице пути буллетов:
сколько высоты под список, сколько её просит каждый поданный элемент, сколько
элементов удержано. Построитель по этим числам раскладывает блоки и пересобирает
деку — значит, мера обязана быть **не оптимистичнее** отрисовки: сказала «эти K
влезают» — рисование обязано нарисовать K без единой потери.

Здесь же закреплены две дыры того же пути, которые молчали: элементы сверх
`max_items` исчезали, не попадая ни в телеметрию, ни в меру, а дашборд резюме
рисовал только первые две темы (`findings[:2]`).

Сеть и база не нужны: эндпоинты зовутся как функции. Нужны Python-пакеты
рендерера (python-pptx, PyMuPDF, fastapi) и LibreOffice для конвертации.

Запуск: python3 renderer/smoke_bullet_measure_matches_render.py
"""

from __future__ import annotations

import copy
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from smoke_counters import print_tap_counters  # noqa: E402

import app  # noqa: E402

failures: list[str] = []
passed_checks = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed_checks
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if ok:
        passed_checks += 1
    else:
        failures.append(name)


def theme_block(title: str, quotes: int, chars: int, meta: bool = True) -> str:
    """Тематический блок в том виде, в каком его печатает построитель."""
    lines = [f"«{title}»", "Найдены публикации по теме:"]
    for i in range(quotes):
        lines.append(f"„{'я' * max(8, chars)} №{i + 1}“ — источник example{i}.com.")
    if meta:
        lines.append("Всего по теме: 26 материалов, с негативным контекстом — 3.")
        lines.append("Где видно: comsuregroup.com, cbonds.com.")
    return "\n".join(lines)


#: Наборы «на грани» и заведомо переполненные: жирные заголовки тем, мета-строки
#: кеглем подписи, длинные цитаты, блоки под бюджет 900 знаков.
ADVERSARIAL_PAGES: list[list[str]] = [
    [theme_block("Криминальные / судебные материалы", 1, 190)],
    [theme_block("Офшоры / корпоративное владение", 2, 210)],
    # На грани: сумма отдельных высот превышает лист, а вместе блоки влезают —
    # мера обязана остаться консервативнее отрисовки, а не наоборот.
    [theme_block(f"Тема {i}", 2, 160) for i in range(3)],
    [theme_block(f"Плотная тема {i}", 1, 60, meta=False) for i in range(6)],
    [theme_block("Единственный очень длинный блок", 4, 200)],
    # Заведомо переполненные: столько на лист не помещается ни при каком счёте.
    [theme_block(f"Тяжёлая тема {i}", 2, 210) for i in range(4)],
    [theme_block(f"Плотная тема {i}", 1, 60, meta=False) for i in range(10)],
]


def prose_deck(pages: list[list[str]], narrative: str | None = None) -> dict[str, Any]:
    slides = []
    for i, bullets in enumerate(pages, start=1):
        slide: dict[str, Any] = {
            "slideKey": f"p{i:02d}_prose",
            "template": "orion_golden_prose",
            "title": f"Материалы повышенного внимания — лист {i}",
            "pageNumber": i,
            "totalPageCount": len(pages),
            "bullets": list(bullets),
        }
        if narrative:
            slide["narrative"] = narrative
        slides.append(slide)
    return {
        "reportSpec": {"subject": {"displayName": "Субъект Проверки"}},
        "deckManifest": {"finalSlides": slides},
        "assets": [],
    }


def request(payload: dict[str, Any]) -> app.OrionGoldenRenderRequest:
    return app.OrionGoldenRenderRequest(
        reportSpec=payload["reportSpec"],
        deckManifest=payload["deckManifest"],
        assets=payload["assets"],
    )


def measure(payload: dict[str, Any]) -> dict[str, Any]:
    res = app.orion_measure_layout(request(payload))
    return {"version": res.version, "pages": [dict(p) for p in res.pages]}


def render_telemetry(payload: dict[str, Any]) -> list[dict[str, Any]]:
    res = app.orion_render_golden(request(payload))
    return list((res.layoutTelemetry or {}).get("entries") or [])


def bullet_lines_on_page(payload: dict[str, Any], page: int) -> int:
    """Сколько блоков списка реально нарисовано на странице.

    Считается по самой презентации: маркер пункта начинает блок. Телеметрия для
    этого не годится — молчаливый срез её и не пишет.
    """
    import orion_golden_render.common as common
    from orion_golden_render.api import _draw_deck

    prs, _warnings, _subject, _slides, _assets = _draw_deck(payload, log_assets=False)
    slide = list(prs.slides)[page - 1]
    marker = common.BULLET_GLYPH
    return sum(
        1
        for shape in slide.shapes
        if shape.has_text_frame
        for para in shape.text_frame.paragraphs
        if para.text.startswith(marker)
    )


def losses(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [e for e in entries if e.get("droppedBullets") or e.get("droppedLines")]


def greedy_fit(page: dict[str, Any]) -> int:
    """Сколько элементов кладёт построитель по вердикту меры.

    Правило то же, что в `planBulletRecut`: суммируем измеренные высоты, пока
    они помещаются в объявленную доступную высоту, и не переходим потолок
    `maxItems`. Ничего не считаем сами — только складываем то, что померил
    рендерер.
    """
    used = 0
    fit = 0
    for h in page["itemHeights"][: page["maxItems"]]:
        if fit > 0 and used + h > page["availableHeight"]:
            break
        used += h
        fit += 1
    return fit


def main() -> int:
    # --- К1. Мера не оптимистичнее отрисовки --------------------------------
    payload = prose_deck(ADVERSARIAL_PAGES)
    verdict = measure(payload)
    check(
        "К1а: версия вердикта названа",
        verdict["version"] == "orion-bullet-measure-v1",
        f"версия {verdict['version']!r}",
    )
    pages = {p["slideKey"]: p for p in verdict["pages"]}
    check(
        "К1б: каждая страница пути буллетов померена",
        len(pages) == len(ADVERSARIAL_PAGES),
        f"померено {len(pages)} из {len(ADVERSARIAL_PAGES)}",
    )
    required = ("slideKey", "availableHeight", "maxItems", "itemHeights", "keptItems")
    missing = sorted({k for k in required for p in verdict["pages"] if k not in p})
    check("К1в: запись меры несёт всё, чем раскладывают", not missing, f"нет полей: {missing}")

    # Раскладываем деку по вердикту и рисуем: потерь быть не должно ни на одной
    # странице. Мера оптимистичнее рисования хотя бы на одном наборе — красный.
    recut = copy.deepcopy(payload)
    for slide in recut["deckManifest"]["finalSlides"]:
        p = pages.get(slide["slideKey"])
        if not p:
            continue
        slide["bullets"] = slide["bullets"][: greedy_fit(p)]
    lost = losses(render_telemetry(recut))
    check(
        "К1г: разложенная по мере дека рисуется без потерь",
        not lost,
        "; ".join(f"{e['name']} −{e.get('droppedBullets')}/{e.get('droppedLines')}" for e in lost),
    )
    check(
        "К1д: проверка не вакуумна — исходная дека потери имела",
        bool(losses(render_telemetry(payload))),
        "адверсарные наборы обязаны переполнять лист",
    )

    # --- К2. Мера детерминирована и следов не оставляет ----------------------
    check("К2а: два мерных прогона дают один ответ", measure(payload) == verdict)
    before = set(os.listdir(os.getcwd()))
    measure(payload)
    new_files = sorted(set(os.listdir(os.getcwd())) - before)
    check("К2б: мера не пишет файлов", not new_files, f"появились: {new_files}")

    # Телеметрия настоящего рендера не должна нести ничего от мерных прогонов.
    solo = render_telemetry(payload)
    measure(payload)
    measure(payload)
    after_measures = render_telemetry(payload)
    check(
        "К2в: телеметрия рендера после мер — ровно своя",
        len(after_measures) == len(solo),
        f"записей {len(after_measures)}, ждали {len(solo)}",
    )

    # --- К3. Слышимость сверх max_items -------------------------------------
    # `orion_golden_prose` рисует не более девяти элементов; подаём двенадцать.
    many = prose_deck([[theme_block(f"Тема {i}", 1, 40, meta=False) for i in range(12)]])
    entries = [e for e in render_telemetry(many) if e.get("role") == "bullets"]
    check("К3а: страница с перебором элементов отчиталась", bool(entries), "записи нет")
    if entries:
        e = entries[0]
        drawn = int(e.get("measuredLines") or 0)
        dropped = int(e.get("droppedBullets") or 0)
        check(
            "К3б: потери = подано − нарисовано (включая срез max_items)",
            drawn + dropped == 12,
            f"нарисовано {drawn}, потеряно {dropped}, подано 12",
        )
        check(
            "К3в: длина текста считается по всем поданным, а не по срезу",
            int(e.get("textLength") or 0) == sum(len(b) for b in many["deckManifest"]["finalSlides"][0]["bullets"]),
            f"textLength {e.get('textLength')}",
        )
    measured_many = measure(many)["pages"]
    check(
        "К3г: мера сообщает высоты всех поданных элементов",
        bool(measured_many) and len(measured_many[0]["itemHeights"]) == 12,
        f"высот {len(measured_many[0]['itemHeights']) if measured_many else 0}",
    )

    # --- К4. Дашборд резюме рисует все темы, а не первые две -----------------
    themes = [theme_block(f"Тема дашборда {i}", 1, 90, meta=False) for i in range(3)]
    dashboard = {
        "reportSpec": {"subject": {"displayName": "Субъект Проверки"}},
        "deckManifest": {
            "finalSlides": [
                {
                    "slideKey": "p03_executive",
                    "template": "orion_golden_executive_dashboard",
                    "title": "Резюме",
                    "pageNumber": 1,
                    "totalPageCount": 1,
                    "narrative": "Итоговая оценка: высокий риск.",
                    "keyFindings": [{"detail": t, "tone": "warn"} for t in themes],
                }
            ]
        },
        "assets": [],
    }
    dash_pages = measure(dashboard)["pages"]
    check(
        "К4а: мера видит все три темы дашборда",
        bool(dash_pages) and len(dash_pages[0]["itemHeights"]) == 3,
        f"высот {len(dash_pages[0]['itemHeights']) if dash_pages else 0}",
    )
    # Считаем нарисованное по самой странице, а не по телеметрии: при
    # молчаливом срезе записи нет вовсе, и «нет записи» — это и есть дефект.
    # Прежняя формулировка подставляла на этот случай 3 и проходила с
    # возвращённым `findings[:2]`.
    drawn_dash = bullet_lines_on_page(dashboard, 1)
    dash_entries = [e for e in render_telemetry(dashboard) if e.get("role") == "bullets"]
    lost_dash = sum(int(e.get("droppedBullets") or 0) for e in dash_entries)
    check(
        "К4б: тема дашборда либо нарисована, либо посчитана потерей",
        drawn_dash + lost_dash == 3,
        f"нарисовано {drawn_dash}, потеряно {lost_dash}",
    )

    print(f"\n{'FAILED (' + str(len(failures)) + ')' if failures else 'PASSED (0 failures)'}")
    print_tap_counters(passed=passed_checks, failed=len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
