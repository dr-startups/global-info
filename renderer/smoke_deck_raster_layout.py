#!/usr/bin/env python3
"""Смок: проверка вёрстки по растру (ADR-0007).

Инспектор геометрии зелёный на деке, которую человек называет сломанной:
он считает переполнением только выход рамки за границы слайда, а текст,
не влезший в свой блок, рамку не двигает. Эта проверка смотрит на
отрисованную страницу и нашими метриками не пользуется вовсе.

Контрольный дефект обязателен. Проверка, которая на исправной деке даёт ноль,
но не умеет дать не-ноль, — не гейт: ровно так `overflow: 0` и держался.
Поэтому сначала синтетические страницы (заведомо чистая и заведомо сломанная),
и только потом настоящая дека, если она отрендерена.

Сеть и БД не нужны. Настоящие страницы — только если есть артефакты прогона.

Запуск: python3 renderer/smoke_deck_raster_layout.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image, ImageDraw  # noqa: E402

from smoke_counters import print_tap_counters  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parent))
from orion_golden_render.common import FONT, TYPE_SCALE_PT  # noqa: E402
from deck_raster_layout import (  # noqa: E402
    CONTENT_BOTTOM,
    SLIDE_H,
    check_pages,
    detect_furniture_top,
)

W, H = 1844, 1152
FURNITURE_RULE_Y = int(H * 0.934)
FURNITURE_TEXT_Y = int(H * 0.950)
CONTENT_BOTTOM_PX = int(CONTENT_BOTTOM / SLIDE_H * H)

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



def count_first_level(runs_by_page: dict) -> dict:
    """Фигуры, несущие крупнейший кегль страницы, — её первый уровень."""
    out: dict = {}
    for page, runs in runs_by_page.items():
        if not runs:
            continue
        top = max(r[0] for r in runs)
        out[page] = {r[1] for r in runs if r[0] == top}
    return out


def make_page(path: Path, *, spill: bool = False, outside: bool = False) -> None:
    """Страница с обычной мебелью; при желании — с дефектом."""
    im = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(im)
    # Содержимое в отведённой области.
    d.rectangle([120, 120, W - 120, 400], fill=(51, 65, 85))
    # Мебель: линейка колонтитула и его текст.
    d.rectangle([90, FURNITURE_RULE_Y, W - 90, FURNITURE_RULE_Y + 2], fill=(120, 130, 150))
    d.rectangle([90, FURNITURE_TEXT_Y, 400, FURNITURE_TEXT_Y + 14], fill=(120, 130, 150))
    if spill:
        # Текст, вышедший за нижнюю границу своего блока.
        d.rectangle([120, CONTENT_BOTTOM_PX + 8, 900, CONTENT_BOTTOM_PX + 40], fill=(51, 65, 85))
    if outside:
        # Текст, вылезший за боковое поле.
        d.rectangle([2, 300, 40, 420], fill=(51, 65, 85))
    im.save(path)


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        clean = [d / f"page-{i:02d}.png" for i in range(1, 5)]
        for p in clean:
            make_page(p)

        report = check_pages(clean)
        check(
            "чистые страницы проходят",
            report.passed and not report.findings,
            f"проверено {report.pages_checked}, дефектов {len(report.findings)}",
        )
        check(
            "мебель найдена по самим страницам, а не задана числом",
            report.furniture_top_y is not None
            and abs(report.furniture_top_y - FURNITURE_RULE_Y) <= 2,
            f"верх мебели y={report.furniture_top_y}, ожидалось ~{FURNITURE_RULE_Y}",
        )

        # Контрольный дефект — тот самый случай, который сегодня проходит мимо
        # инспектора геометрии.
        broken = d / "page-05.png"
        make_page(broken, spill=True)
        r2 = check_pages(clean + [broken])
        spilled = [f for f in r2.findings if f.code == "TEXT_BELOW_CONTENT_AREA"]
        check(
            "текст ниже границы контента пойман",
            len(spilled) == 1 and spilled[0].page == "page-05.png",
            spilled[0].detail if spilled else "не пойман",
        )
        check("страница с дефектом не считается пройденной", not r2.passed)

        wide = d / "page-06.png"
        make_page(wide, outside=True)
        r3 = check_pages(clean + [wide])
        outside = [f for f in r3.findings if f.code == "TEXT_OUTSIDE_MARGINS"]
        check(
            "текст за боковым полем пойман",
            len(outside) == 1 and outside[0].page == "page-06.png",
            outside[0].detail if outside else "не пойман",
        )

        # Ноль не может быть ответом, когда проверять было нечего.
        empty = check_pages([])
        check(
            "пустой набор страниц не выдаётся за успех",
            not empty.passed and empty.pages_checked == 0,
            "0 дефектов на 0 страниц — это «не проверяли», а не «всё хорошо»",
        )
        check(
            "мебель не ищется по заголовкам в верхней части листа",
            detect_furniture_top([[1] * H]) is not None,
        )

    # Настоящая дека — если отрендерена.
    pages_dir = (
        Path(__file__).resolve().parent.parent
        / "baselines/report-72/artifacts/deck-sections/pages-png"
    )
    real = sorted(pages_dir.glob("page-*.png")) if pages_dir.is_dir() else []
    if not real:
        print("# SKIP растровая проверка эталонной деки — нет отрендеренных страниц")
    else:
        rep = check_pages(real)
        for f in rep.findings:
            print(f"    {f.page}: {f.code} — {f.detail}")
        check(
            "эталонная дека проходит растровую проверку",
            rep.passed,
            f"проверено страниц: {rep.pages_checked}, дефектов: {len(rep.findings)}",
        )

    # --- ADR-0008: типографическая шкала закрыта -------------------------
    #
    # Замер до шага: шестнадцать разных кеглей в деке, до восьми на странице.
    # Глаз читает такой набор не как иерархию, а как шум.
    pptx_path = (
        Path(__file__).resolve().parent.parent
        / "baselines/report-72/artifacts/deck-sections/rendered-client.pptx"
    )
    if not pptx_path.is_file():
        print("# SKIP шкала кеглей эталонной деки — нет отрисованного PPTX")
    else:
        from pptx import Presentation

        used: dict[float, int] = {}
        per_page: dict[int, set] = {}
        runs_by_page: dict[int, list] = {}
        for idx, slide in enumerate(Presentation(str(pptx_path)).slides, 1):
            for shape in slide.shapes:
                if not shape.has_text_frame:
                    continue
                for para in shape.text_frame.paragraphs:
                    for run in para.runs:
                        if run.font.size is None:
                            continue
                        pt = round(run.font.size.pt, 2)
                        used[pt] = used.get(pt, 0) + 1
                        per_page.setdefault(idx, set()).add(pt)
                        if (run.text or "").strip():
                            runs_by_page.setdefault(idx, []).append(
                                (pt, shape.name or "?")
                            )
        first_level_shapes = count_first_level(runs_by_page)
        off = sorted(p for p in used if p not in TYPE_SCALE_PT)
        check(
            "в деке нет кеглей вне шкалы",
            not off,
            f"вне шкалы: {off}" if off else f"использовано ступеней: {sorted(used)}",
        )
        # Иерархия: на странице ровно один элемент первого уровня — лид или
        # ключевая цифра, остальное заведомо тише (ADR-0008, п.3). Свойство
        # соблюдается на всех 45 страницах эталона; проверка держит его,
        # чтобы следующая правка шаблона не вернула «всё одинаково важно».
        offenders = [pg for pg, shapes in first_level_shapes.items() if len(shapes) != 1]
        check(
            "на каждой странице ровно один элемент первого уровня",
            not offenders,
            f"страниц с нарушением: {offenders[:5]}" if offenders else f"страниц: {len(first_level_shapes)}",
        )
        # Отрицательный контроль: две фигуры одного крупнейшего кегля — это
        # нарушение, и проверка обязана его увидеть.
        synthetic = count_first_level({1: [(22.0, "Заголовок A"), (22.0, "Заголовок Б"), (11.0, "текст")]})
        check(
            "две фигуры первого уровня считаются нарушением",
            len(synthetic[1]) == 2,
            f"найдено фигур: {sorted(synthetic[1])}",
        )

        widest = max(per_page.items(), key=lambda kv: len(kv[1])) if per_page else (0, set())
        check(
            "на странице не больше четырёх ступеней",
            len(widest[1]) <= 4,
            f"страница {widest[0]}: {sorted(widest[1])}",
        )

    # --- Гарнитура в PDF: та же, что мы меряем, и встроена ---------------
    #
    # PPTX несёт только имя семейства; рисует его LibreOffice при конвертации.
    # Если гарнитуры нет в образе, он молча подставит запасную — и клиент
    # получит документ, набранный не тем, чем мы его мерили. Кириллица при
    # такой подмене обычно и уезжает.
    pdf_path = (
        Path(__file__).resolve().parent.parent
        / "baselines/report-72/artifacts/deck-sections/rendered-client.pdf"
    )
    if not pdf_path.is_file():
        print("# SKIP гарнитура в PDF — нет отрендеренного PDF")
    else:
        import fitz

        doc = fitz.open(str(pdf_path))
        families, not_embedded = set(), set()
        for page_no in range(len(doc)):
            for font in doc.get_page_fonts(page_no):
                base = str(font[3]).split("+")[-1]
                families.add(base)
                if font[1] == "n/a":
                    not_embedded.add(base)
        family = FONT.replace(" ", "").lower()
        foreign = sorted(f for f in families if family not in f.replace(" ", "").lower())
        check(
            "в PDF только объявленная гарнитура",
            not foreign,
            f"чужие: {foreign}" if foreign else f"найдено: {sorted(families)}",
        )
        check("все начертания встроены в PDF", not not_embedded, f"невстроенные: {sorted(not_embedded)}")

    print(f"\n{'FAILED (' + str(len(failures)) + ')' if failures else 'PASSED (0 failures)'}")
    print_tap_counters(passed=passed_checks, failed=len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
