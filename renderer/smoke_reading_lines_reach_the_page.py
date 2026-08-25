#!/usr/bin/env python3
"""Смок: слова о чтении и выводы страниц доезжают до листа, а не до payload.

На прогоне 76 отчёт запросил 120 страниц, прочитал 74 — и не сказал об этом
нигде. Оба носителя честности убила вёрстка, а не построители:

  * `orion_golden_search_table` печатал над таблицей два первых законченных
    предложения, и строка покрытия, стоявшая третьим, исчезала без записи;
  * страница региона (`orion_golden_metrics_dashboard`) поля `statusNote` не
    получала вовсе — фраза с процентом и базой не имела печатного носителя.

Счётчик предложений снят: сколько абзаца влезет, решает мера в пределах
объявленного потолка. Отсюда Т8в и Т8г — «почему важно», «что проверить» и
правило ручной верификации обязаны быть на листе, а не только в нагрузке.

Проверяется именно лист: текст шейпов после отрисовки. Числа здесь
синтетические — только счётчики, без имён и материалов реального дела.

Сеть, база и LibreOffice не нужны: презентация строится в памяти.

Запуск: python3 renderer/smoke_reading_lines_reach_the_page.py (нужен python-pptx)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pptx import Presentation  # noqa: E402
from pptx.util import Emu  # noqa: E402

from smoke_counters import print_tap_counters  # noqa: E402
from orion_golden_render.common import SLIDE_H, SLIDE_W, _Ctx  # noqa: E402
from orion_golden_render.slides import _render_slide  # noqa: E402

#: Интро страницы тем в том виде, в каком его собирает построитель секций.
THEMES_INTRO = (
    "Из 120 отобранных по отчёту страниц прочитано 74; каждая прочитанная отнесена "
    "к теме по её содержанию, нежелательных публикаций: 15. "
    "Из непрочитанных: 23 закрыли доступ, 17 без читаемого текста, 6 не ответили."
)

#: Статусная строка страницы региона: доля негатива и база, по которой она посчитана.
READ_SHARE = (
    "Негатив среди прочитанных страниц региона: 15 из 50 (30%); "
    "прочитано 50 из 86 отобранных."
)

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


def render(slide: dict[str, Any], page: int = 9) -> Any:
    prs = Presentation()
    prs.slide_width = Emu(SLIDE_W)
    prs.slide_height = Emu(SLIDE_H)
    ctx = _Ctx(prs, page, 48)
    _render_slide(ctx, slide, {})
    return prs


def page_text(prs: Any) -> str:
    """Весь текст листа: текстовые короба плюс ячейки таблиц."""
    parts: list[str] = []
    for sh in prs.slides[0].shapes:
        if getattr(sh, "has_text_frame", False):
            parts.append(sh.text_frame.text)
        if getattr(sh, "has_table", False):
            for row in sh.table.rows:
                for cell in row.cells:
                    parts.append(cell.text)
    return "\n".join(parts)


def main() -> int:
    # --- Т8а. Двухпредложное интро страницы тем напечатано целиком -----------
    themes = render(
        {
            "template": "orion_golden_search_table",
            "title": "Россия — о чём публикации в ТОП-20",
            "narrative": THEMES_INTRO,
            "table": {
                "headers": ["Тема", "Публикаций", "Из них нежелательных"],
                "rows": [
                    ["Криминальные / судебные материалы", "20", "10"],
                    ["Деловая репутация", "12", "5"],
                ],
            },
        }
    )
    themes_text = page_text(themes)
    check("Т8а1: страница тем называет прочитанное", "74" in themes_text, themes_text[:120])
    check("Т8а2: страница тем называет базу", "120 отобранных" in themes_text, themes_text[:120])
    check(
        "Т8а3: причины отказов напечатаны вторым предложением",
        "23 закрыли доступ" in themes_text and "6 не ответили" in themes_text,
        themes_text[:200],
    )
    check(
        "Т8а4: абсолюта «прочитаны» без базы на листе нет",
        "прочитаны" not in themes_text,
        themes_text[:120],
    )

    # --- Т8в. Страница выдачи печатает весь свой абзац ------------------------
    #
    # Шаблон брал из нарратива первые два законченных предложения и остальное
    # выбрасывал без записи. «Почему важно» и «что проверить» страницы выдачи
    # до клиента не доезжали вовсе: на эталоне 72 так терялись 13 × 2
    # предложения. Проверяется текст фигур готового листа, а не мера: мерить
    # лист тем же прибором, который его резал, бессмысленно.
    serp = render(
        {
            "template": "orion_golden_search_table",
            "title": "Россия — Яндекс, ТОП-20 (1/4)",
            "narrative": "\n".join(
                [
                    "Показана выдача Яндекса по запросу «Глинка Сергей Михайлович». "
                    "«PEP / RCA / watchlist-сигналы» — средний уровень внимания.",
                    "На странице 1 тема повышенного внимания — эти материалы видны при "
                    "первой же проверке субъекта.",
                    "Запросить первичные карточки баз и подтвердить принадлежность совпадений.",
                ]
            ),
            "table": {
                "headers": ["№", "Заголовок", "Тип источника", "Оценка"],
                "rows": [
                    ["1", "Материал о проверке", "СМИ", "Нежелательный"],
                    ["2", "Деловая публикация", "СМИ", "Нейтральный"],
                ],
                "rowAddresses": ["kommersant.ru/doc/1", "forbes.ru/2"],
            },
        }
    )
    serp_text = page_text(serp)
    check(
        "Т8в1: страница выдачи называет запрос своей таблицы",
        "по запросу «Глинка Сергей Михайлович»" in serp_text,
        serp_text[:200],
    )
    check(
        "Т8в2: вывод страницы напечатан",
        "средний уровень внимания" in serp_text,
        serp_text[:200],
    )
    check(
        "Т8в3: «почему важно» доезжает до листа",
        "видны при первой же проверке субъекта" in serp_text,
        serp_text[:400],
    )
    check(
        "Т8в4: «что проверить» доезжает до листа",
        "подтвердить принадлежность совпадений" in serp_text,
        serp_text[:400],
    )

    # --- Т8г. Сводка комплаенса печатает правило ручной верификации -----------
    #
    # «Совпадение по комплаенсу не подтверждается автоматически» — правило
    # продукта, и до этого шага у него не было печатного носителя: рекомендация
    # стояла третьим предложением и отбрасывалась.
    compliance = render(
        {
            "template": "orion_golden_search_table",
            "title": "Комплаенс-базы: что проверялось",
            "narrative": "\n".join(
                [
                    "Записей о субъекте в комплаенс-базах: 3 (Dow Jones, LexisNexis и "
                    "World-Check). Совпадение по базе не подтверждается автоматически: "
                    "подтверждено аналитиком — 0, требует ручной проверки — 0, статус не "
                    "зафиксирован — 3.",
                    "Верифицировать каждое потенциальное совпадение вручную: сопоставить "
                    "идентификаторы субъекта с записью базы.",
                ]
            ),
            "table": {
                "headers": ["База данных", "Тип совпадения", "Оценка совпадения", "Статус проверки"],
                "rows": [
                    ["Dow Jones", "PEP", "78/100", "Не подтверждено"],
                    ["LexisNexis", "Публикации", "—", "Не подтверждено"],
                ],
            },
        },
        page=33,
    )
    compliance_text = page_text(compliance)
    check(
        "Т8г1: сводка комплаенса печатает предложение о ручной верификации",
        "Верифицировать каждое потенциальное совпадение вручную" in compliance_text,
        compliance_text[:400],
    )
    check(
        "Т8г2: разбивка статусов на листе осталась",
        "статус не зафиксирован — 3" in compliance_text,
        compliance_text[:400],
    )

    # --- Т8б. Статусная строка страницы региона ------------------------------
    dashboard = render(
        {
            "template": "orion_golden_metrics_dashboard",
            "title": "Россия: в выдаче есть материалы повышенного внимания",
            "narrative": "Предмет аудита по региону «Россия» — ТОП-20 выдачи: 20 материалов.",
            "statusNote": READ_SHARE,
            "metrics": [
                {"label": "Собрано по региону", "value": "404", "tone": "neutral"},
                {"label": "Тем повышенного внимания", "value": "2", "tone": "risk"},
            ],
            "actions": [{"label": "Проверить актуальные статусы дел."}],
            "bullets": ["«Криминальные / судебные материалы». Всего по теме: 7 материалов."],
        },
        page=7,
    )
    dash_text = page_text(dashboard)
    check("Т8б1: доля негатива напечатана", "15 из 50 (30%)" in dash_text, dash_text[:200])
    check("Т8б2: база доли напечатана", "прочитано 50 из 86 отобранных" in dash_text, dash_text[:200])
    check(
        "Т8б3: нарратив и карточка действия на месте",
        "ТОП-20 выдачи" in dash_text and "статусы дел" in dash_text,
        dash_text[:200],
    )

    without = render(
        {
            "template": "orion_golden_metrics_dashboard",
            "title": "Обзор цифрового профиля",
            "narrative": "Предмет аудита по региону «Россия» — ТОП-20 выдачи: 20 материалов.",
            "metrics": [{"label": "Собрано по региону", "value": "404", "tone": "neutral"}],
        },
        page=5,
    )
    check(
        "Т8б4: без статусной строки страница её не выдумывает",
        "прочитано" not in page_text(without),
        page_text(without)[:200],
    )

    print(f"\n{'FAILED (' + str(len(failures)) + ')' if failures else 'PASSED (0 failures)'}")
    print_tap_counters(passed=passed_checks, failed=len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
