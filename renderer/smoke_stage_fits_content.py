#!/usr/bin/env python3
"""Смок: белая сцена кончается под содержимым, а не у нижнего поля (шаг 0127).

`content_stage` рисует сцену **до** содержимого и всегда тянет её до
`CONTENT_BOTTOM`. Стр. 20 отчёта Абрамовича 20.09.2026 («Россия — о чём
публикации в ТОП-20») — таблица из пяти строк в рамке во весь лист: две трети
страницы белые. То же на стр. 4, 8 и 12. Владелец прочитал это как
«полупустые страницы».

Содержимого от этого не прибавится — прибавить его было бы выдумкой. Но лист
не обязан обещать содержимое, которого нет: сцена сжимается до фактического
низа нарисованного, с полем снизу.

Проверяется:
  * С1 — короткое содержимое: сцена кончается заметно выше `CONTENT_BOTTOM`;
  * С2 — сцена всё равно ниже последней нарисованной фигуры (ничего не срезано);
  * С3 — полный лист: сцена остаётся во всю высоту, как прежде;
  * С4 — тень и уголки сцены двигаются вместе с ней, ниже сцены чернил нет.

Сеть и база не нужны. Нужен python-pptx.

Запуск: python3 renderer/smoke_stage_fits_content.py
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
    CONTENT_BOTTOM,
    SLIDE_H,
    SLIDE_W,
    _Ctx,
    reset_bullet_measure,
    reset_layout_telemetry,
)
from orion_golden_render.layout_cleeq import content_stage  # noqa: E402

failures: list[str] = []
passed_checks = 0

#: Запас под сценой, ниже которого сжатие считается косметикой, а не починкой.
MIN_SAVED = 800_000


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed_checks
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if ok:
        passed_checks += 1
    else:
        failures.append(name)


def fresh(key: str) -> tuple[Any, _Ctx]:
    reset_layout_telemetry()
    reset_bullet_measure()
    prs = Presentation()
    prs.slide_width = Emu(SLIDE_W)
    prs.slide_height = Emu(SLIDE_H)
    return prs, _Ctx(prs, 20, 69, slide_key=key)


def stage_card(ctx: _Ctx) -> Any:
    """Белая сцена — та фигура, которую запомнил `draw_stage`."""
    return getattr(ctx, "stage_card", None)


def ink_bottom(ctx: _Ctx, *, skip: set[int]) -> int:
    """Низ содержимого. Фигуры различаются по `shape_id`: при обходе
    python-pptx отдаёт новую обёртку, и тождество объектов здесь не работает."""
    bottom = 0
    for sh in ctx.slide.shapes:
        if int(sh.shape_id) in skip:
            continue
        bottom = max(bottom, int(sh.top or 0) + int(sh.height or 0))
    return bottom


def short_page() -> None:
    """Короткий лист: заголовок, абзац и три строки — как стр. 20."""
    _, ctx = fresh("p20_short")
    ctx.light_bg()
    y = ctx.title("Россия — о чём публикации в ТОП-20")
    content_stage(ctx, y)
    y = ctx.body(
        "Из 120 отобранных по отчёту страниц прочитано 82; в таблицу вошли 9 публикаций.",
        y,
        max_h=700_000,
    )
    y = ctx.bullets(["Санкции, ограничения активов и гражданство — 2 публикации."], y, max_items=3)
    ctx.fit_stage()
    card = stage_card(ctx)
    if card is None:
        check("С1: сцена короткого листа кончается выше нижнего поля", False, "сцена не запомнена")
        check("С2: сцена не срезает содержимое", False, "сцена не запомнена")
        return
    stage_bottom = int(card.top) + int(card.height)
    saved = CONTENT_BOTTOM - stage_bottom
    check(
        "С1: сцена короткого листа кончается заметно выше нижнего поля",
        saved >= MIN_SAVED,
        f"низ сцены {stage_bottom}, нижнее поле {CONTENT_BOTTOM}, сэкономлено {saved}",
    )
    shadow = getattr(ctx, "stage_shadow", None)
    skip = {int(card.shape_id)} | (
        {int(shadow.shape_id)} if shadow is not None else set()
    )
    content = ink_bottom(ctx, skip=skip)
    check(
        "С2: сцена не срезает содержимое — её низ не выше последней фигуры",
        stage_bottom >= content,
        f"низ сцены {stage_bottom}, низ содержимого {content}",
    )


def full_page() -> None:
    """Лист, заполненный до низа: сцена остаётся во всю высоту."""
    _, ctx = fresh("p12_full")
    ctx.light_bg()
    y = ctx.title("Россия: в выдаче есть материалы повышенного внимания")
    content_stage(ctx, y)
    block = "\n".join(
        ["Тема блока", "Первая строка блока: 3 материала.", "Вторая строка блока о том же."]
    )
    ctx.bullets([block] * 9, y, max_items=9, max_chars=900)
    ctx.fit_stage()
    card = stage_card(ctx)
    stage_bottom = int(card.top) + int(card.height) if card is not None else -1
    check(
        "С3: заполненный лист сцену не теряет",
        card is not None and CONTENT_BOTTOM - stage_bottom < MIN_SAVED,
        f"низ сцены {stage_bottom}, нижнее поле {CONTENT_BOTTOM}",
    )


def shadow_follows() -> None:
    """Тень сцены двигается вместе с ней: чернил ниже сцены быть не должно."""
    _, ctx = fresh("p20_shadow")
    ctx.light_bg()
    y = ctx.title("Комплаенс — сводка баз данных")
    content_stage(ctx, y, corner_marks=True)
    ctx.body("Проверено баз: 3. Совпадений: 1.", y, max_h=500_000)
    ctx.fit_stage()
    card = stage_card(ctx)
    shadow = getattr(ctx, "stage_shadow", None)
    if card is None or shadow is None:
        check("С4: тень и уголки следуют за сценой", False, "сцена или тень не запомнены")
        return
    stage_bottom = int(card.top) + int(card.height)
    shadow_bottom = int(shadow.top) + int(shadow.height)
    marks = getattr(ctx, "stage_marks", [])
    marks_ok = all(int(m.top) + int(m.height) <= shadow_bottom for m in marks)
    check(
        "С4: тень и уголки следуют за сценой, ниже сцены чернил нет",
        shadow_bottom <= CONTENT_BOTTOM and shadow_bottom - stage_bottom < 200_000 and marks_ok,
        f"низ сцены {stage_bottom}, низ тени {shadow_bottom}, уголков {len(marks)}",
    )


def main() -> int:
    short_page()
    full_page()
    shadow_follows()
    print(f"\n{'FAILED (' + str(len(failures)) + ')' if failures else 'PASSED (0 failures)'}")
    print_tap_counters(passed=passed_checks, failed=len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
