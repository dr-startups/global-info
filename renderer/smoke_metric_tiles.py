#!/usr/bin/env python3
"""Смок: плитки метрик лежат одним рядом, высота ряда — по содержимому (шаг 0101).

Что держит:

- до шести метрик — один ряд; второй ряд ради одной-трёх плиток стоил листу
  860 000 EMU, и на странице региона из-за него уезжал блок тем;
- ряд не выше, чем нужно содержимому: подписи в одну строку — 600 000 EMU;
- подпись в две строки лежит **внутри** плитки — прежде она ложилась на нижний
  край по арифметике (62,2 pt содержимого в плитке 61,4 pt);
- резюме печатает все свои метрики: `metrics[:4]` молча терял пятую;
- шкала кеглей страницы: не больше четырёх ступеней и один элемент первого
  уровня (ADR-0008) — число плитки 20 pt, первым уровнем становится заголовок;
- лишние метрики называются потерей, а не срезаются молча.

Геометрия «внутри плитки» проверяется чужим прибором — вёрсткой LibreOffice:
низ последней строки подписи в PDF сверяется с низом подложки плитки. Мера
рендерера тут не годится: она и решает, какой высоты быть плитке.

Сеть и база не нужны. Запуск: python3 renderer/smoke_metric_tiles.py
"""

from __future__ import annotations

import base64
import io
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fitz  # noqa: E402
from pptx import Presentation  # noqa: E402
from pptx.util import Emu  # noqa: E402

from smoke_counters import print_tap_counters  # noqa: E402
from orion_golden_render import render_orion_golden  # noqa: E402
from orion_golden_render.common import (  # noqa: E402
    CONTENT_W,
    MARGIN_X,
    SLIDE_H,
    SLIDE_W,
    _Ctx,
    get_bullet_measure,
    get_layout_telemetry,
    reset_bullet_measure,
    reset_layout_telemetry,
)
from orion_golden_render.slides import _render_slide  # noqa: E402

failures: list[str] = []
passed_checks = 0

EMU_PER_PT = 12_700
ROW_GAP = 80_000
#: Обвязка плиток до шага: два ряда по 780 000 и отбивка между ними.
OLD_TWO_ROW_CHROME = 780_000 + ROW_GAP + 780_000


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed_checks
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if ok:
        passed_checks += 1
    else:
        failures.append(name)


def metrics_of(items: list[tuple[str, str]]) -> list[dict[str, str]]:
    return [{"value": value, "label": label, "tone": "neutral"} for value, label in items]


THEME = "\n".join(
    [
        "«Судебные материалы»",
        "Найдены публикации по теме:",
        "«Суд назначил заседание по делу фонда» — источник kapital-nyheter.se",
        "Всего по теме: 5 материалов, с негативным контекстом — 3.",
    ]
)
FIVE = [
    ("41", "В аудите (ТОП-20)"),
    ("255", "Собрано по региону"),
    ("3", "Тем повышенного внимания"),
    ("5", "Тем подтверждено"),
    ("3", "Вероятно о субъекте"),
]
SHORT_FOUR = [("246", "Собрано"), ("3", "Тем риска"), ("5", "Подтверждено"), ("0", "Вероятно")]
SEVEN = [
    ("341", "Материалов собрано"),
    ("324", "Связаны с проверяемым лицом"),
    ("3", "Вероятно о субъекте"),
    ("9", "Требуют идентификации"),
    ("5", "Относятся к другим лицам"),
    ("3", "Тем повышенного внимания"),
    ("Россия · ОАЭ", "Региональные контуры"),
]
#: Худшее, что может прийти в ряд: подписи под потолок реза (40 знаков) с
#: длинными словами и значение-фраза.
WORST_SIX = [
    ("1 234", "Материалов, требующих идентификации лица"),
    ("Данные не собраны", "Идентифицированных упоминаний субъекта"),
    ("87", "Подтверждённых тем повышенного внимания"),
    ("5", "Относятся к другим лицам и однофамильцам"),
    ("12", "Региональных контуров международных"),
    ("0 / 10", "Вероятно относящихся к проверяемому"),
]


def region(metrics: list[tuple[str, str]], bullets: int = 4) -> dict[str, Any]:
    return {
        "template": "orion_golden_metrics_dashboard",
        "slideKey": "p07_ru_summary",
        "title": "Россия: в выдаче есть материалы повышенного внимания",
        "narrative": "По региону «Россия» собрано 255 материалов. Подтверждённых тем: 5, из них повышенного внимания: 3.",
        "metrics": metrics_of(metrics),
        "bullets": [THEME] * bullets,
    }


def draw(slide: dict[str, Any], page: int = 13) -> Any:
    reset_layout_telemetry()
    reset_bullet_measure()
    prs = Presentation()
    prs.slide_width = Emu(SLIDE_W)
    prs.slide_height = Emu(SLIDE_H)
    ctx = _Ctx(prs, page, 66, slide_key=str(slide.get("slideKey") or "p13"))
    _render_slide(ctx, slide, {})
    return prs.slides[0]


def text_boxes(slide: Any) -> list[Any]:
    return [sh for sh in slide.shapes if getattr(sh, "has_text_frame", False) and sh.text_frame.text.strip()]


def tile_boxes(slide: Any, metrics: list[tuple[str, str]]) -> list[Any]:
    """Текстовые рамки плиток — по тексту «значение ⏎ подпись», в порядке метрик."""
    boxes = text_boxes(slide)
    found = []
    for value, label in metrics:
        match = [sh for sh in boxes if sh.text_frame.text.strip() == f"{value}\n{label}"]
        if match:
            found.append(match[0])
    return found


def card_of(slide: Any, box: Any) -> Any:
    """Подложка плитки: наименьшая фигура без текста, внутри которой стоит рамка."""
    holders = [
        sh
        for sh in slide.shapes
        if not (getattr(sh, "has_text_frame", False) and sh.text_frame.text.strip())
        and int(sh.left) <= int(box.left) <= int(sh.left) + int(sh.width)
        and int(sh.top) <= int(box.top) <= int(sh.top) + int(sh.height)
    ]
    return min(holders, key=lambda sh: int(sh.width) * int(sh.height)) if holders else None


def narrative_top(slide: Any) -> int | None:
    found = [sh for sh in text_boxes(slide) if sh.text_frame.text.startswith("По региону")]
    return int(found[0].top) if found else None


def font_sizes(slide: Any) -> dict[float, set[int]]:
    """Кегль → фигуры, которые его несут (по порядковому номеру фигуры)."""
    out: dict[float, set[int]] = {}
    for index, sh in enumerate(slide.shapes):
        if not getattr(sh, "has_text_frame", False):
            continue
        for para in sh.text_frame.paragraphs:
            for run in para.runs:
                if run.font.size is not None and (run.text or "").strip():
                    out.setdefault(round(run.font.size.pt, 2), set()).add(index)
    return out


def p1_one_row_up_to_six() -> None:
    slide = draw(region(FIVE))
    tiles = tile_boxes(slide, FIVE)
    tops = sorted({int(card_of(slide, box).top) for box in tiles if card_of(slide, box) is not None})
    check("П1а: пять метрик лежат одним рядом", len(tiles) == 5 and len(tops) == 1, f"плиток {len(tiles)}, верхи рядов {tops}")
    top = narrative_top(slide)
    check(
        "П1б: абзац под плитками начинается не ниже 2 310 000 — было 3 010 000 при втором ряде",
        top is not None and top <= 2_310_000,
        f"верх абзаца {top}",
    )


def p2_short_captions_row_is_600k() -> None:
    slide = draw(region(SHORT_FOUR))
    tiles = tile_boxes(slide, SHORT_FOUR)
    cards = [card_of(slide, box) for box in tiles]
    heights = sorted({int(c.height) for c in cards if c is not None})
    widths = [int(c.width) for c in cards if c is not None]
    hero_w = int(CONTENT_W * 0.34)
    tile_w = (CONTENT_W - hero_w - ROW_GAP - 2 * ROW_GAP) // 3
    check("П2а: подписи в одну строку — ряд 600 000 EMU", heights == [600_000], f"высоты плиток {heights}")
    check(
        "П2б: ширины четырёх плиток прежние — первая 34 % ряда",
        widths == [hero_w, tile_w, tile_w, tile_w],
        f"ширины {widths} против {[hero_w, tile_w, tile_w, tile_w]}",
    )
    lefts = [int(c.left) for c in cards if c is not None]
    check(
        "П2в: ряд занимает всю полосу содержимого",
        bool(lefts) and lefts[0] == MARGIN_X and lefts[-1] + widths[-1] in range(MARGIN_X + CONTENT_W - 3, MARGIN_X + CONTENT_W + 1),
        f"левый край {lefts[:1]}, правый {lefts[-1] + widths[-1] if lefts else None} при полосе до {MARGIN_X + CONTENT_W}",
    )


def p4_resume_prints_every_metric() -> None:
    resume_metrics = [
        ("341", "Материалов собрано"),
        ("324", "О субъекте"),
        ("3", "Вероятно о субъекте"),
        ("3", "Тем риска"),
        ("5", "Ключевых тем"),
    ]
    slide = draw(
        {
            "template": "orion_golden_executive_dashboard",
            "slideKey": "p03_executive",
            "title": "Резюме",
            "narrative": "Итоговая оценка: высокий риск.",
            "metrics": metrics_of(resume_metrics),
        },
        page=4,
    )
    printed = [label for _value, label in resume_metrics if any(label in sh.text_frame.text for sh in text_boxes(slide))]
    check(
        "П4: резюме печатает все свои метрики — пятая («Ключевых тем») терялась молча",
        printed == [label for _value, label in resume_metrics],
        f"напечатано подписей {len(printed)} из {len(resume_metrics)}: {printed}",
    )


def p5_seven_metrics_two_rows() -> None:
    slide = draw(region(SEVEN), page=10)
    tiles = tile_boxes(slide, SEVEN)
    cards = [card_of(slide, box) for box in tiles]
    rows: dict[int, list[Any]] = {}
    for card in cards:
        if card is not None:
            rows.setdefault(int(card.top), []).append(card)
    tops = sorted(rows)
    counts = [len(rows[t]) for t in tops]
    gap = tops[1] - (tops[0] + int(rows[tops[0]][0].height)) if len(tops) == 2 else None
    check(
        "П5: семь метрик — два ряда 4 + 3, второй под первым через 80 000",
        len(tiles) == 7 and counts == [4, 3] and gap == ROW_GAP,
        f"плиток {len(tiles)}, в рядах {counts}, отбивка {gap}",
    )


def p6_type_scale_of_the_page() -> None:
    for name, slide in (
        ("страница региона", draw(region(FIVE))),
        ("профиль, семь метрик", draw(region(SEVEN), page=10)),
    ):
        sizes = font_sizes(slide)
        top = max(sizes) if sizes else 0
        check(
            f"П6: {name} — кегли из {{22, 20, 11, 9}}, первый уровень один",
            set(sizes) <= {22.0, 20.0, 11.0, 9.0} and len(sizes.get(top, ())) == 1 and top == 22.0,
            f"кегли {sorted(sizes)}, фигур первого уровня {len(sizes.get(top, ()))}",
        )


def p8_room_for_the_list() -> None:
    draw(region(FIVE))
    measures = get_bullet_measure()
    available = int(measures[-1].get("availableHeight") or 0) if measures else 0
    kept = int(measures[-1].get("keptItems") or 0) if measures else 0
    check(
        "П8: лист региона с пятью метриками отдаёт под список не меньше 3 500 000 EMU и держит три блока из четырёх",
        available >= 3_500_000 and kept == 3,
        f"под список {available} (было 2 777 385), блоков на листе {kept} (было 2)",
    )


def p9_extra_metrics_are_a_named_loss() -> None:
    thirteen = [(str(i + 1), f"Показатель {i + 1}") for i in range(13)]
    slide = draw(region(thirteen))
    drawn = len(tile_boxes(slide, thirteen))
    # Потеря ищется по имени записи: список под плитками на таком листе тоже
    # теряет блоки, и его запись — не та, что нужна.
    losses = [
        e
        for e in get_layout_telemetry()
        if "metric" in str(e.get("name") or "")
        and (int(e.get("droppedLines") or 0) > 0 or int(e.get("droppedBullets") or 0) > 0)
    ]
    check(
        "П9: тринадцатая метрика — названная потеря, а не молчаливый срез",
        drawn == 12 and len(losses) == 1,
        f"нарисовано плиток {drawn}, потерь плиток в телеметрии {len(losses)}",
    )


def render_with_libreoffice(slides: list[dict[str, Any]]) -> tuple[Any, Any] | None:
    payload = {
        "reportSpec": {"subject": {"displayName": "Субъект Проверки"}},
        "deckManifest": {
            "finalSlides": [
                {**slide, "slideKey": f"p{i:02d}_tiles", "pageNumber": i, "totalPageCount": len(slides)}
                for i, slide in enumerate(slides, start=1)
            ]
        },
        "assets": [],
    }
    out = render_orion_golden(payload)
    if out.get("pdfExportMode") != "libreoffice":
        return None
    prs = Presentation(io.BytesIO(base64.b64decode(out["pptxBase64"])))
    doc = fitz.open(stream=base64.b64decode(out["pdfBase64"]), filetype="pdf")
    return prs, doc


def p3_p7_captions_stay_inside_the_tile() -> None:
    cases = [("П3", "подпись в две строки", FIVE), ("П7", "худший ряд из шести", WORST_SIX)]
    rendered = render_with_libreoffice([region(metrics, bullets=1) for _tag, _name, metrics in cases])
    if rendered is None:
        print("# SKIP П3/П7 подпись внутри плитки — LibreOffice недоступен, вёрстку судить нечем")
        return
    prs, doc = rendered
    for index, (tag, name, metrics) in enumerate(cases):
        slide = prs.slides[index]
        tiles = tile_boxes(slide, metrics)
        cards = [card_of(slide, box) for box in tiles]
        worst: tuple[str, float] | None = None
        measured = 0
        for (_value, label), card in zip(metrics, cards):
            if card is None:
                continue
            left_pt, right_pt = int(card.left) / EMU_PER_PT, (int(card.left) + int(card.width)) / EMU_PER_PT
            top_pt, bottom_pt = int(card.top) / EMU_PER_PT, (int(card.top) + int(card.height)) / EMU_PER_PT
            words = set(label.split())
            bottoms = [
                span["bbox"][3]
                for block in doc[index].get_text("dict")["blocks"]
                for line in block.get("lines", [])
                for span in line.get("spans", [])
                if span["text"].strip()
                and left_pt - 1 <= span["bbox"][0] <= right_pt
                # Окно — плитка и одна строка подписи под ней: абзац страницы
                # начинается на 140 000 EMU (11 pt) ниже плиток и несёт те же
                # слова («повышенного внимания»), окно шире ловило бы его.
                and top_pt - 1 <= span["bbox"][1] <= bottom_pt + 10
                and words & set(span["text"].split())
            ]
            if not bottoms:
                continue
            measured += 1
            spill = max(bottoms) - bottom_pt
            if worst is None or spill > worst[1]:
                worst = (label, spill)
        check(
            f"{tag}а: {name} — подписи всех плиток найдены в PDF",
            measured == len(metrics),
            f"найдено {measured} из {len(metrics)}",
        )
        check(
            f"{tag}б: {name} — последняя строка подписи не ниже низа плитки",
            worst is not None and worst[1] <= 0.5,
            f"худшая подпись «{worst[0]}»: ниже плитки на {worst[1]:.1f} pt" if worst else "нечего мерить",
        )
        rows = sorted({int(c.top) for c in cards if c is not None})
        chrome = (
            max(int(c.top) + int(c.height) for c in cards if c is not None) - rows[0] if rows else 0
        )
        heights = sorted({int(c.height) for c in cards if c is not None})
        if tag == "П3":
            check(
                "П3в: ряд с подписью в две строки выше пола, но не выше прежних 780 000",
                bool(heights) and 600_000 < heights[-1] <= 780_000 and len(rows) == 1,
                f"высоты плиток {heights}, рядов {len(rows)}",
            )
        else:
            check(
                "П7в: обвязка худшего ряда из шести не выше прежней для того же числа метрик (1 640 000)",
                0 < chrome <= OLD_TWO_ROW_CHROME and len(rows) == 1,
                f"обвязка {chrome}, рядов {len(rows)}",
            )


def main() -> int:
    p1_one_row_up_to_six()
    p2_short_captions_row_is_600k()
    p3_p7_captions_stay_inside_the_tile()
    p4_resume_prints_every_metric()
    p5_seven_metrics_two_rows()
    p6_type_scale_of_the_page()
    p8_room_for_the_list()
    p9_extra_metrics_are_a_named_loss()

    print(f"\n{'FAILED (' + str(len(failures)) + ')' if failures else 'PASSED (0 failures)'}")
    print_tap_counters(passed=passed_checks, failed=len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
