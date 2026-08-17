#!/usr/bin/env python3
"""Смок: карточная сетка матрицы рисков рисует всё, что ей дали, и говорит о потере.

На прогоне 72 страница 6 несла три карточки в модели и две на бумаге: третья
(«PEP / RCA / watchlist-сигналы») не была нарисована нигде в деке. Причина —
`_safe` на входе detail: он схлопывал переносы, строчная логика карточки
умирала, карточки раздувались и последняя не помещалась. Симптом никто не
поймал: карточная сетка не писала телеметрию, а без входа правило
`CONTENT_DROPPED_BY_RENDERER` исполнять нечему.

Проверяется оба конца:
  * здоровая страница — нарисованы все карточки, переносы дожили до абзацев,
    «Что делать» стоит своей строкой, потерь по телеметрии ноль;
  * контрольный дефект — страница карточек-переростков: лишние не рисуются,
    телеметрия сообщает потерю, и инспектор геометрии даёт по ней
    `CONTENT_DROPPED_BY_RENDERER`. Проверка, не умеющая дать не-ноль, — не
    проверка.

Сеть, база и LibreOffice не нужны: презентация строится в памяти, инспектор
геометрии читает файл из временного каталога.

Запуск: python3 renderer/smoke_risk_matrix_cards.py (нужен python-pptx)
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pptx import Presentation  # noqa: E402
from pptx.util import Emu  # noqa: E402

from smoke_counters import print_tap_counters  # noqa: E402
from orion_golden_render.common import (  # noqa: E402
    SLIDE_H,
    SLIDE_W,
    _Ctx,
    get_layout_telemetry,
    reset_layout_telemetry,
)
from orion_golden_render.executive import _render_risk_matrix_grid  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
INSPECTOR = REPO_ROOT / "scripts" / "inspect-first36-pptx-geometry.py"

#: Сводная карточка в том виде, в каком её собирает построитель секций.
SUMMARY_DETAIL = (
    "7 свидетельств (5 негативных) в источниках audit-it.ru, x.com, m.sledst.org.\n"
    "Что делать: Проверить статусы дел и первоисточники до принятия решений."
)
#: Карточка-переросток: столько текста на странице помещается не всё.
OVERSIZED_DETAIL = (
    "В открытых источниках описан длительный корпоративный конфликт вокруг актива, "
    "стороны публично обвиняют друг друга в давлении на суд и в использовании "
    "административного ресурса, публикации выходят в изданиях нескольких стран и "
    "повторяются с интервалом в несколько недель, дополняясь новыми подробностями "
    "сделки и составом участников. "
) * 3

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


def card(idx: int, detail: str) -> dict[str, str]:
    return {
        "headline": f"Тема риска {idx}",
        "status": "Критический" if idx == 1 else "Высокий",
        "detail": detail,
        "tone": "risk",
    }


def render_page(cards: list[dict[str, str]], page: int = 6) -> tuple[Any, list[dict[str, Any]]]:
    """Отрисовать одну страницу матрицы и вернуть презентацию с телеметрией."""
    reset_layout_telemetry()
    prs = Presentation()
    prs.slide_width = Emu(SLIDE_W)
    prs.slide_height = Emu(SLIDE_H)
    ctx = _Ctx(prs, page, 48)
    _render_risk_matrix_grid(ctx, {"keyFindings": cards}, "Матрица комплаенс-рисков")
    return prs, get_layout_telemetry()


def drawn_headlines(prs: Any, cards: list[dict[str, str]]) -> list[str]:
    wanted = {c["headline"] for c in cards}
    slide = prs.slides[0]
    return [
        sh.text_frame.text
        for sh in slide.shapes
        if getattr(sh, "has_text_frame", False) and sh.text_frame.text in wanted
    ]


def detail_paragraphs(prs: Any) -> list[list[str]]:
    """Абзацы текстовых коробов, несущих тело карточки."""
    out: list[list[str]] = []
    for sh in prs.slides[0].shapes:
        if not getattr(sh, "has_text_frame", False):
            continue
        paras = [p.text for p in sh.text_frame.paragraphs if p.text.strip()]
        if any(p.startswith("Что делать:") for p in paras):
            out.append(paras)
    return out


def risk_entries(telemetry: list[dict[str, Any]], page: int) -> list[dict[str, Any]]:
    return [
        e
        for e in telemetry
        if e.get("page") == page and str(e.get("name") or "").startswith("orion_risk_matrix")
    ]


def inspector_codes(prs: Any, telemetry: list[dict[str, Any]]) -> list[str]:
    """Прогнать инспектор геометрии по странице вместе с её телеметрией."""
    with tempfile.TemporaryDirectory() as tmp:
        pptx_path = Path(tmp) / "page.pptx"
        prs.save(str(pptx_path))
        (Path(tmp) / "layout-telemetry.json").write_text(
            json.dumps({"version": "orion-layout-telemetry-v1", "entries": telemetry}, ensure_ascii=False),
            encoding="utf-8",
        )
        out = subprocess.run(
            [sys.executable, "-X", "utf8", str(INSPECTOR), str(pptx_path)],
            capture_output=True,
            encoding="utf-8",
            check=False,
        )
        report = json.loads(out.stdout or "{}")
    return [str(c.get("code")) for c in report.get("clipping") or []]


def main() -> int:
    # --- К1. Здоровая страница: полный лист сводных карточек -----------------
    # Ёмкость страницы объявлена реестром шаблонов на стороне TS; сюда она
    # переписана числом, потому что смок в реестр не ходит. Держится замером:
    # сводная карточка стоит 1 063 536 EMU плюс зазор 50 000, под содержимым
    # страницы 5 025 200 — четыре занимают 4 454 144, пятая не помещается.
    PAGE_CARDS = 4
    healthy = [card(i, SUMMARY_DETAIL) for i in range(1, PAGE_CARDS + 1)]
    prs, telemetry = render_page(healthy)
    drawn = drawn_headlines(prs, healthy)
    check(
        f"К1а: нарисованы все {PAGE_CARDS} сводные карточки листа",
        len(drawn) == PAGE_CARDS,
        f"нарисовано {len(drawn)}: {', '.join(drawn) or '—'}",
    )
    bodies = detail_paragraphs(prs)
    check(
        "К1б: тело каждой карточки — не меньше двух абзацев (переносы дожили)",
        len(bodies) == PAGE_CARDS and all(len(b) >= 2 for b in bodies),
        f"абзацев по карточкам: {[len(b) for b in bodies]}",
    )
    check(
        "К1в: «Что делать» стоит отдельной строкой, а не вклейкой",
        len(bodies) == PAGE_CARDS and all(b[-1].startswith("Что делать:") for b in bodies),
        f"последние строки: {[b[-1][:32] for b in bodies]}",
    )
    entries = risk_entries(telemetry, 6)
    check(
        "К1г: страница матрицы написала запись телеметрии",
        len(entries) == 1,
        f"записей {len(entries)} из {len(telemetry)}",
    )
    dropped = sum(
        int(e.get("droppedBullets") or 0) + int(e.get("droppedLines") or 0) for e in entries
    )
    check("К1д: потерь по телеметрии ноль", dropped == 0, f"потеряно {dropped}")
    check(
        "К1е: инспектор геометрии молчит о потере содержимого",
        "CONTENT_DROPPED_BY_RENDERER" not in inspector_codes(prs, telemetry),
        "",
    )

    # --- К2. Список карточек рендерер не режет -------------------------------
    # Ёмкость страницы — ответ построителя; рендерер отвечает только за то,
    # влезает ли карточка целиком. Здесь проверяется именно отсутствие своего
    # среза списка, поэтому карточки взяты без тела: семь голых заголовков
    # (424 040 EMU каждый) по высоте помещаются, а срез на шесть — нет.
    seven = [card(i, "") for i in range(1, 8)]
    prs7, telemetry7 = render_page(seven)
    drawn7 = drawn_headlines(prs7, seven)
    check("К2а: семь коротких карточек нарисованы все", len(drawn7) == 7, f"нарисовано {len(drawn7)}")
    entries7 = risk_entries(telemetry7, 6)
    check(
        "К2б: телеметрия насчитала семь нарисованных карточек",
        len(entries7) == 1 and entries7[0].get("measuredLines") == 7,
        f"запись: {entries7[0] if entries7 else '—'}",
    )

    # --- К3. Контрольный дефект: переростки не рисуются и об этом слышно -----
    monsters = [card(i, OVERSIZED_DETAIL) for i in range(1, 7)]
    prs_bad, telemetry_bad = render_page(monsters)
    drawn_bad = drawn_headlines(prs_bad, monsters)
    check(
        "К3а: карточка, не влезающая целиком, не нарисована",
        len(drawn_bad) < len(monsters),
        f"нарисовано {len(drawn_bad)} из {len(monsters)}",
    )
    entries_bad = risk_entries(telemetry_bad, 6)
    dropped_bad = sum(
        int(e.get("droppedBullets") or 0) + int(e.get("droppedLines") or 0) for e in entries_bad
    )
    check(
        "К3б: телеметрия сообщает потерю",
        len(entries_bad) == 1 and dropped_bad == len(monsters) - len(drawn_bad) and dropped_bad > 0,
        f"потеряно по телеметрии {dropped_bad}, не нарисовано {len(monsters) - len(drawn_bad)}",
    )
    codes = inspector_codes(prs_bad, telemetry_bad)
    check(
        "К3в: инспектор геометрии даёт CONTENT_DROPPED_BY_RENDERER",
        "CONTENT_DROPPED_BY_RENDERER" in codes,
        f"коды: {', '.join(sorted(set(codes))) or '—'}",
    )

    print(f"\n{'FAILED (' + str(len(failures)) + ')' if failures else 'PASSED (0 failures)'}")
    print_tap_counters(passed=passed_checks, failed=len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
