"""Проверка вёрстки по растру — второе мнение о странице.

Зачем отдельный инструмент. Инспектор геометрии считает переполнением только
выход **рамки** за границы слайда, а текст, не влезший в свой блок, рамку не
двигает: рамка остаётся на месте, и дефект, на который жалуется заказчик,
проверке не виден по построению. Хуже того, длина строки там считается теми же
метриками, которыми рендерер решает, сколько текста поместится, — проверка
меряет тем же инструментом, который создаёт дефект, и подтверждает сама себя.

Здесь берётся отрисованная страница. Растр не пользуется нашими метриками
вовсе, поэтому не наследует их ошибку.

Мебель страницы (линейка колонтитула и его текст) определяется по самим
страницам, а не задаётся числами: строки, закрашенные почти на каждой странице
деки, — это и есть мебель. Иначе порог пришлось бы держать в двух местах —
здесь и в шаблоне, — и он бы разошёлся.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover — Pillow приходит с python-pptx
    raise RuntimeError(
        "ORION raster layout: нет Pillow. Он приходит зависимостью python-pptx — "
        "проверьте образ рендерера."
    ) from exc

# Геометрия мастер-слайда: те же значения, что у рендерера (common.py).
SLIDE_W = 11_704_320
SLIDE_H = 7_315_200
MARGIN_X = 480_000
CONTENT_BOTTOM = SLIDE_H - 1_100_000

#: Низ белой сцены страницы и низ её тени — те же значения, что у рендерера
#: (`layout_cleeq.content_stage`: высота сцены = граница контента минус смещение
#: тени 45 000 минус зазор 60 000; тень рисуется на 45 000 ниже сцены).
STAGE_BOTTOM = CONTENT_BOTTOM - 45_000 - 60_000
STAGE_SHADOW_BOTTOM = STAGE_BOTTOM + 45_000

#: Ниже этой линии чернил не бывает ни на одной странице деки.
#:
#: Не `CONTENT_BOTTOM`: сцена кончается на 6 110 200, её тень — на 6 155 200, и
#: ниже не рисует никто. Прежний порог лежал ещё на 60 000 EMU (девять
#: пикселей) ниже тени, и в этот зазор помещалась целая строка таблицы: на
#: эталоне 25.08 стр. 17 доходила до y=972 при кромке сцены 962 — таблица была
#: нарисована поверх кромки, а ворота молчали. Замер того же дня: при пороге
#: 6 155 200 из 49 страниц краснеет ровно эта одна.
INK_BOTTOM = STAGE_SHADOW_BOTTOM

#: Насколько пиксель должен отличаться от фона, чтобы считаться чернилами.
#: Сумма модулей по каналам: подписи серым (0x64748B) на белом дают ~380.
INK_TOLERANCE = 28

#: Доля страниц, на которых строка должна быть закрашена, чтобы считаться
#: мебелью. Не 1.0: на обложке колонтитул может быть иного тона.
FURNITURE_SHARE = 0.9

#: Сколько отсчётов чернил в запретной зоне считать дефектом, а не следом
#: сглаживания на границе фигуры.
INK_NOISE_FLOOR = 24

#: Кромка самого растра, а не страницы: экспорт PDF→PNG оставляет по краю
#: светлую линию в один пиксель (212,215,219). На белых листах она тонет в фоне,
#: на тёмных отличается от него — и давала «текст за полями» на обложке и
#: разделителях, ровно 538 отсчётов в столбце x=W-1. Содержимое так близко к
#: краю не подходит: боковое поле шире на два порядка.
RASTER_EDGE_INSET = 2


@dataclass
class PageFinding:
    page: str
    code: str
    detail: str


@dataclass
class RasterLayoutReport:
    """Итог проверки.

    `pagesChecked` печатается всегда и намеренно: отчёт «0 дефектов на 0
    проверенных страниц» обязан быть невозможен.
    """

    pages_checked: int = 0
    furniture_top_y: int | None = None
    findings: list[PageFinding] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return self.pages_checked > 0 and not self.findings


def _ink_row_counts(path: Path, step: int = 2) -> tuple[list[int], int, int]:
    """Сколько чернил в каждой строке страницы; фон берётся по углу."""
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    bg = px[2, 2]
    rows: list[int] = []
    for y in range(h):
        n = 0
        for x in range(0, w, step):
            q = px[x, y]
            if abs(q[0] - bg[0]) + abs(q[1] - bg[1]) + abs(q[2] - bg[2]) > INK_TOLERANCE:
                n += 1
        rows.append(n)
    return rows, w, h


def detect_furniture_top(profiles: Sequence[Sequence[int]]) -> int | None:
    """Верхняя граница мебели: с неё начинается колонтитул.

    Ищется в нижней трети, чтобы заголовок, стоящий на каждой странице на одной
    высоте, не был принят за колонтитул.
    """
    if not profiles:
        return None
    height = len(profiles[0])
    threshold = max(1, int(len(profiles) * FURNITURE_SHARE))
    lower_third = int(height * 0.66)
    inked_everywhere = [
        y
        for y in range(lower_third, height)
        if sum(1 for p in profiles if y < len(p) and p[y] > 0) >= threshold
    ]
    return min(inked_everywhere) if inked_everywhere else None


def check_pages(paths: Iterable[Path]) -> RasterLayoutReport:
    paths = sorted(paths)
    report = RasterLayoutReport()
    if not paths:
        return report

    scans = [(p, *_ink_row_counts(p)) for p in paths]
    profiles = [rows for _p, rows, _w, _h in scans]
    furniture_top = detect_furniture_top(profiles)
    report.furniture_top_y = furniture_top

    for path, rows, w, h in scans:
        report.pages_checked += 1
        ink_bottom_px = int(INK_BOTTOM / SLIDE_H * h)
        # Ниже последней законной линии чернил, но выше мебели, содержимого
        # быть не должно: это текст, вышедший за свой блок.
        limit = furniture_top if furniture_top is not None else h
        spill = sum(rows[y] for y in range(min(ink_bottom_px, limit), limit))
        if spill > INK_NOISE_FLOOR:
            lowest = max(
                (y for y in range(ink_bottom_px, limit) if rows[y] > 0),
                default=ink_bottom_px,
            )
            report.findings.append(
                PageFinding(
                    page=path.name,
                    code="TEXT_BELOW_CONTENT_AREA",
                    detail=(
                        f"{spill} отсчётов чернил ниже границы контента "
                        f"(y={ink_bottom_px}), самый низкий y={lowest} "
                        f"при мебели с y={furniture_top}"
                    ),
                )
            )

        side = _side_margin_ink(path, w, h, limit)
        if side > INK_NOISE_FLOOR:
            report.findings.append(
                PageFinding(
                    page=path.name,
                    code="TEXT_OUTSIDE_MARGINS",
                    detail=f"{side} отсчётов чернил за боковыми полями",
                )
            )
    return report


def _side_margin_ink(path: Path, w: int, h: int, limit: int, step: int = 2) -> int:
    """Чернила левее левого и правее правого поля страницы."""
    im = Image.open(path).convert("RGB")
    px = im.load()
    bg = px[2, 2]
    left_px = int(MARGIN_X / SLIDE_W * w * 0.6)
    right_px = w - left_px
    n = 0
    inset = RASTER_EDGE_INSET
    for y in range(inset, max(inset, limit), step):
        for x in list(range(inset, left_px, step)) + list(range(right_px, w - inset, step)):
            q = px[x, y]
            if abs(q[0] - bg[0]) + abs(q[1] - bg[1]) + abs(q[2] - bg[2]) > INK_TOLERANCE:
                n += 1
    return n
