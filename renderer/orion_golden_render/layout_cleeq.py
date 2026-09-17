"""Компоновки cleeq: плавающая сцена, квадратные маркеры, шкала уровня.

Перенесено из ветки `feature/checkpoint` (1a949bd — «cleeq-стиль отчёта»).
Там же взяты пропорции: страница мятная, содержимое лежит на белой «сцене» с
мягкой тенью, маркер — квадрат, а не точка, степень риска показана шкалой из
пяти делений.

Перенесён визуальный язык, а не его геометрия. В исходной ветке новые
компоновки резали текст (`_clip_words` до влезания, `bullets[:5]`,
фиксированная высота строки таблицы) и писали кегли литералами — 40, 28, 12,5.
На отрисовке эталонной деки той ветки это даёт `overflow: 5`, обрывы фраз на
полуслове и шестнадцать кеглей вместо восьми. Здесь то же самое выглядит так:

- сцена рисуется **под** обычным потоком текста и выступает за колонку наружу,
  поэтому ширина строки и ёмкость страницы не меняются ни на EMU. Ёмкость листа
  меряет сам код отрисовки (`ctx.bullets`), и построитель спрашивает её мерным
  прогоном — подвинуть содержимое значит потерять его;
- кегли берутся из объявленной шкалы (`TYPE_SCALE_PT`): литералы в коде и дают
  шестнадцать кеглей на деку вместо восьми;
- текст меряется тем начертанием, которым рисуется: жирный лид, померенный
  обычным, занижает высоту абзаца и роняет содержимое ниже границы контента.
"""

from __future__ import annotations

import re
from typing import Any

from pptx.dml.color import RGBColor
from pptx.util import Emu, Pt

from .common import (
    ACCENT,
    CARD_BORDER,
    CONTENT_BOTTOM,
    CONTENT_W,
    FONT,
    FS_BODY,
    FS_CAPTION,
    FS_LEAD,
    MARGIN_X,
    MUTED_COLOR,
    STAGE_SHADOW,
    TONE_RISK,
    TONE_WARN,
    VIOLET,
    WHITE,
    _Ctx,
    _clip_words,
    disable_shape_shadow,
    _fit_text_to_height,
    _safe,
    _wrapped_line_count,
    font_line_step_emu,
    measure_text_height,
    record_text_layout,
)

#: Насколько сцена выступает за текстовую колонку. Внутренние поля карточки
#: получаются из этого выступа, а колонка остаётся прежней ширины.
#:
#: Больше брать нельзя: тень сцены — это чернила на растре, и растровая
#: проверка считает дефектом всё, что заходит за 0,6 бокового поля
#: (288 000 EMU от края). При выступе 100 000 правый край тени приходится на
#: 11 359 320 при пороге 11 416 320 — запас 57 000 EMU.
STAGE_BLEED = 100_000

#: Смещение тени. Тень — единственное, чем белая сцена отличается от мятного
#: листа настолько, чтобы её было видно: белое по #F6F8F4 глаз почти не ловит.
STAGE_SHADOW_DX = 35_000
STAGE_SHADOW_DY = 45_000

#: Пол высоты ряда метрик (шаг 0101): число 20 pt с подписью 9 pt в одну
#: строку и поля — 47,1 pt. Выше пола ряд поднимает только содержимое: подпись
#: в две строки или значение-фраза, и тогда ряд считается по мере, а не
#: назначается. Прежние 780 000 назначались на все случаи и всё равно не
#: вмещали подпись в две строки — она ложилась на нижний край плитки.
METRIC_ROW_MIN_H = 600_000
#: Отбивка между плитками и между рядами.
METRIC_GAP = 80_000
#: Сколько плиток несёт ряд: до шести — один ряд, дальше два поровну. Второй
#: ряд ради одной-трёх метрик стоил листу 860 000 EMU, и на странице региона
#: из-за него уезжал блок тем.
METRICS_PER_ROW = 6
#: Больше двух рядов лист не несёт: лишние метрики — потеря, названная в
#: телеметрии, а не молчаливый срез. Построители столько не выпускают.
METRIC_ROWS_MAX = 2
#: Первая плитка ряда шире остальных: 1,6 доли, но не больше 34 % ряда. При
#: четырёх плитках это ровно прежняя геометрия; при пяти-шести она сужается
#: вместе с остальными.
HERO_SHARE = 1.6
#: Поля плитки по вертикали — над числом и под подписью. Внутренние отступы
#: текстовой рамки по вертикали сняты, чтобы высота считалась в лоб.
TILE_PAD_TOP = 76_200
TILE_PAD_BOTTOM = 63_500
#: Горизонтальное поле плитки до текстовой рамки плюс её собственный отступ.
TILE_PAD_X = 140_000
TILE_TEXT_INSET = 91_440


def draw_stage(ctx: _Ctx, x: int, y: int, w: int, h: int) -> None:
    """Белая сцена с мягкой тенью — плоскость, на которой лежит содержимое.

    Тень у сцены ровно одна: сдвинутый серый прямоугольник, чью геометрию мы
    знаем. Собственную мягкую тень фигуры LibreOffice рисует по умолчанию, и
    размывается она примерно на десять точек **за** границей фигуры — то есть
    ниже границы контентной области, где растровая проверка справедливо видит
    чернила. Гасим её здесь, а не поднимаем сцену: подниматься ей некуда, текст
    доходит до самого низа полосы.
    """
    shadow = ctx.slide.shapes.add_shape(
        5, Emu(x + STAGE_SHADOW_DX), Emu(y + STAGE_SHADOW_DY), Emu(w), Emu(h)
    )
    shadow.fill.solid()
    shadow.fill.fore_color.rgb = STAGE_SHADOW
    shadow.line.fill.background()
    disable_shape_shadow(shadow)
    try:
        shadow.adjustments[0] = 0.06
    except Exception:  # noqa: BLE001
        pass
    card = ctx.card(y, h=h, x=x, w=w, fill=WHITE, border=None, radius=0.06)
    disable_shape_shadow(card)


def content_stage(
    ctx: _Ctx,
    y: int,
    *,
    bottom: int | None = None,
    top: int | None = None,
    corner_marks: bool = False,
) -> int:
    """Сцена вокруг обычной текстовой колонки; возвращает её низ.

    Колонка (`MARGIN_X`..`+CONTENT_W`) не сдвигается и не сужается: сцена
    выступает наружу на `STAGE_BLEED`, и этот выступ и есть её внутреннее поле.
    Так страница получает белую плоскость, не теряя ни строки содержимого.

    `top` задаётся, когда над сценой уже что-то нарисовано: сцена кладётся
    поверх более ранних фигур, и выступ вверх срезал бы нижний край плиток
    метрик вместе с подписями.
    """
    limit = CONTENT_BOTTOM if bottom is None else min(bottom, CONTENT_BOTTOM)
    top = max(0, y - STAGE_BLEED) if top is None else max(0, top)
    # Тень обязана остаться выше границы контентной области: растровая проверка
    # считает дефектом любые чернила ниже неё, а тень — это чернила.
    height = limit - top - STAGE_SHADOW_DY - 60_000
    if height < 400_000:
        return y
    left = MARGIN_X - STAGE_BLEED
    width = CONTENT_W + 2 * STAGE_BLEED
    draw_stage(ctx, left, top, width, height)
    if corner_marks:
        draw_corner_marks(ctx, left, top, width, height)
    return top + height


def draw_corner_marks(ctx: _Ctx, x: int, y: int, w: int, h: int) -> None:
    """Зелёные уголки по краям сцены выводов."""
    for cx, cy in (
        (x + 40_000, y + 40_000),
        (x + w - 120_000, y + 40_000),
        (x + 40_000, y + h - 120_000),
        (x + w - 120_000, y + h - 120_000),
    ):
        mark = ctx.slide.shapes.add_shape(1, Emu(cx), Emu(cy), Emu(80_000), Emu(14_000))
        mark.fill.solid()
        mark.fill.fore_color.rgb = ACCENT
        mark.line.fill.background()


def draw_level_bars(
    ctx: _Ctx,
    x: int,
    y: int,
    *,
    filled: int,
    total: int = 5,
    seg_w: int = 120_000,
    seg_h: int = 90_000,
    gap: int = 30_000,
    hot: RGBColor = TONE_RISK,
    cold: RGBColor = CARD_BORDER,
) -> None:
    """Шкала степени: пять делений, закрашено столько, какова степень."""
    for i in range(total):
        sx = x + i * (seg_w + gap)
        shape = ctx.slide.shapes.add_shape(5, Emu(sx), Emu(y), Emu(seg_w), Emu(seg_h))
        shape.fill.solid()
        shape.fill.fore_color.rgb = hot if i < filled else cold
        shape.line.fill.background()
        try:
            shape.adjustments[0] = 0.35
        except Exception:  # noqa: BLE001
            pass


def level_step(text: str) -> str | None:
    """Ступень клиентской шкалы по напечатанному слову: `high`/`medium`/`low`.

    Единственное место в рендерере, которое узнаёт ступень. Слов ровно три —
    столько печатает клиентская шкала (`orion-golden/client/risk-scale.ts`);
    `None` означает «это не ступень», и такой ответ получают статусы
    («Требует подтверждения», «Нет данных»). По тону ступень не определяется:
    тон `warn` носит и «Средний», и статус.
    """
    word = (text or "").lower()
    if "высок" in word:
        return "high"
    if "сред" in word:
        return "medium"
    if "низк" in word:
        return "low"
    return None


#: Делений шкалы на ступень. Ноль — шкалы нет вовсе: статус её не рисует.
_BARS_BY_STEP = {"high": 5, "medium": 3, "low": 2}


def bars_for_level(pill: str) -> int:
    """Сколько делений шкалы закрашено; ноль — шкалу не рисовать."""
    return _BARS_BY_STEP.get(level_step(pill) or "", 0)


def bars_color(filled: int) -> RGBColor:
    return TONE_RISK if filled >= 4 else TONE_WARN


def render_metric_rows(
    ctx: _Ctx,
    metrics: list[dict[str, Any]],
    x: int,
    y: int,
    width: int,
    *,
    tone_value_color,
) -> int:
    """Плитки метрик страницы — один ответ на вопрос «как они лежат».

    До шести метрик — один ряд; больше — два ряда поровну, первый не меньше
    второго (семь метрик профиля — 4 + 3). Высота каждого ряда — по самой
    высокой плитке, не ниже `METRIC_ROW_MIN_H`. Рисуются **все** поданные
    метрики: резюме прежде резало `metrics[:4]` и молча теряло пятую.

    Число — `FS_LEAD` (20 pt), подпись — `FS_CAPTION`: на странице уже стоят
    заголовок 22 pt, текст 11 и подпись 9, а шкала кеглей разрешает не больше
    четырёх ступеней на страницу и ровно один элемент первого уровня (держит
    `smoke_deck_raster_layout.py`). Прежний герой 26 pt был этим первым
    уровнем; теперь им, как на остальных страницах, служит заголовок. Ряд в
    600 000 EMU иначе недостижим: число 26 pt — это строка 31,5 pt, и вместе с
    подписью и полями плитка не уложилась бы в 47,2 pt.
    """
    items = [m for m in metrics if isinstance(m, dict) and _safe(m.get("value"))]
    if not items:
        return y
    shown = items[: METRICS_PER_ROW * METRIC_ROWS_MAX]
    if len(shown) < len(items):
        record_text_layout(
            page=ctx.page,
            name=f"orion_metric_tiles_p{ctx.page}",
            role="text",
            font_family=FONT,
            font_size_pt=FS_LEAD,
            box_width=width,
            box_height=0,
            available_height=0,
            required_height=METRIC_ROW_MIN_H,
            measured_lines=len(shown),
            text_length=sum(len(_safe(m.get("label"))) for m in items),
            clipped=True,
            dropped_bullets=len(items) - len(shown),
        )
    rows = [shown] if len(shown) <= METRICS_PER_ROW else [shown[: (len(shown) + 1) // 2], shown[(len(shown) + 1) // 2 :]]
    for index, row in enumerate(rows):
        if index:
            y += METRIC_GAP
        y = _render_metric_row(ctx, row, x, y, width, hero=index == 0, tone_value_color=tone_value_color)
    return y


def _metric_row_widths(count: int, width: int, *, hero: bool) -> list[int]:
    """Ширины плиток ряда: первая — герой, остальные равные."""
    if count <= 1:
        return [width]
    if not hero:
        tile_w = (width - METRIC_GAP * (count - 1)) // count
        return [tile_w] * count
    unit = (width - METRIC_GAP * (count - 1)) / (count - 1 + HERO_SHARE)
    hero_w = min(int(width * 0.34), int(unit * HERO_SHARE))
    rest_w = width - hero_w - METRIC_GAP
    tile_w = (rest_w - METRIC_GAP * (count - 2)) // (count - 1)
    return [hero_w] + [tile_w] * (count - 1)


def _render_metric_row(
    ctx: _Ctx,
    row: list[dict[str, Any]],
    x: int,
    y: int,
    width: int,
    *,
    hero: bool,
    tone_value_color,
) -> int:
    widths = _metric_row_widths(len(row), width, hero=hero)
    row_h = max([METRIC_ROW_MIN_H, *(_metric_tile_height(m, w) for m, w in zip(row, widths))])
    left = x
    for metric, tile_w in zip(row, widths):
        _metric_tile(ctx, metric, left, y, tile_w, row_h, tone_value_color=tone_value_color)
        left += tile_w + METRIC_GAP
    return y + row_h


def _metric_texts(metric: dict[str, Any]) -> tuple[str, str, float]:
    """Значение, подпись и кегль значения — одни на замер и на вывод."""
    value = _clip_words(_safe(metric.get("value")), 36)
    label = _clip_words(_safe(metric.get("label")), 40)
    # Длинное значение — это не цифра, а фраза вроде «Данные не собраны»:
    # крупным кеглем она не помещается и распадается на три строки.
    size = FS_LEAD if len(value) <= 10 else FS_BODY
    return value, label, float(size)


def _metric_tile_height(metric: dict[str, Any], w: int) -> int:
    """Высота плитки по содержимому — тем же переносом, которым текст рисуется.

    Ширина текста — рамка без горизонтальных отступов: на узкой плитке
    отступы съедают заметную долю, и мера по полной ширине рамки обещала бы
    одну строку там, где вёрстка даёт две.
    """
    value, label, size = _metric_texts(metric)
    text_w = max(120_000, w - 2 * TILE_PAD_X - 2 * TILE_TEXT_INSET)
    value_h = _wrapped_line_count(value, text_w, size, True) * font_line_step_emu(size, 1.0, True)
    label_h = _wrapped_line_count(label, text_w, FS_CAPTION) * font_line_step_emu(FS_CAPTION, 1.0)
    return TILE_PAD_TOP + value_h + int(1 * 12_700) + label_h + TILE_PAD_BOTTOM


def _metric_tile(
    ctx: _Ctx,
    metric: dict[str, Any],
    x: int,
    y: int,
    w: int,
    h: int,
    *,
    tone_value_color,
) -> None:
    tone = str(metric.get("tone") or "neutral")
    value, label, size = _metric_texts(metric)
    ctx.card(y, h=h, x=x, w=w, fill=WHITE, border=None, radius=0.1)
    box = ctx.slide.shapes.add_textbox(
        Emu(x + TILE_PAD_X), Emu(y + TILE_PAD_TOP), Emu(w - 2 * TILE_PAD_X), Emu(h - TILE_PAD_TOP - TILE_PAD_BOTTOM)
    )
    tf = box.text_frame
    tf.word_wrap = True
    # Вертикальные отступы рамки — ноль: высота плитки посчитана от полей
    # плитки, и скрытые 45 720 EMU сверху сдвигали бы подпись за нижний край.
    tf.margin_top = Emu(0)
    tf.margin_bottom = Emu(0)
    p0 = tf.paragraphs[0]
    p0.line_spacing = 1.0
    r0 = p0.add_run()
    r0.text = value
    r0.font.name = FONT
    r0.font.bold = True
    r0.font.size = Pt(size)
    r0.font.color.rgb = tone_value_color(tone)
    p1 = tf.add_paragraph()
    p1.space_before = Pt(1)
    p1.line_spacing = 1.0
    r1 = p1.add_run()
    r1.text = label
    r1.font.name = FONT
    r1.font.size = Pt(FS_CAPTION)
    r1.font.color.rgb = MUTED_COLOR


def stage_heading(ctx: _Ctx, text: str, y: int, *, x: int | None = None, w: int | None = None) -> int:
    """Зелёный подзаголовок внутри сцены («Действие», «Выводы»).

    Кегль основного текста: на странице уже заняты четыре ступени шкалы, и
    иерархию здесь несут цвет и начертание, а не пятый размер.
    """
    left = MARGIN_X if x is None else x
    width = CONTENT_W if w is None else w
    box = ctx.slide.shapes.add_textbox(Emu(left), Emu(y), Emu(width), Emu(200_000))
    r = box.text_frame.paragraphs[0].add_run()
    r.text = _safe(text)
    r.font.name = FONT
    r.font.bold = True
    r.font.size = Pt(FS_BODY)
    r.font.color.rgb = ACCENT
    return y + 200_000


def _advice_key(text: str) -> str:
    """Рекомендация для сравнения: без регистра, пробелов и конечного знака."""
    return re.sub(r"[\s.!?…]+$", "", _safe(text)).casefold()


def narrative_without_advice(paragraphs: list[str], label: str) -> tuple[list[str], bool]:
    """Абзацы страницы без рекомендации, которую напечатает блок действия.

    Проза находки кладёт рекомендацию последним абзацем страницы
    (`composeFindingProse`), и она же едет дашборду полем `actions` — под свой
    заголовок. Страница печатала одну и ту же фразу дважды: абзацем и под
    «Действие» / «Следующий шаг».

    Снимается только **дословный** повтор — абзац целиком, каким его и пишет
    приложение: разные слова в абзаце и в действии остаются оба. Второй ответ —
    было ли что снято: вызывающий после этого **обязан** напечатать блок
    действия, иначе рекомендация пропадёт вовсе.
    """
    key = _advice_key(label)
    if not key:
        return list(paragraphs), False
    kept = [para for para in paragraphs if _advice_key(para) != key]
    return kept, len(kept) != len(paragraphs)


def action_block_reserve(label: str) -> int:
    """Сколько высоты держать под блок действия, чтобы он напечатался наверняка.

    Числа те же, которыми блок решает, рисоваться ли: порог 420 000, полоса
    заголовка и отбивок 260 000 и высота текста той же мерой, что у `ctx.body`.
    """
    text = _safe(label)
    if not text:
        return 0
    body = measure_text_height(text, CONTENT_W, FS_BODY, line_spacing=1.2)
    return max(420_000, body + 260_000 + 80_000)


def print_moved_advice(ctx: _Ctx, advice: str, y: int) -> int:
    """Рекомендация, снятая из абзаца, обязана напечататься — хоть строкой.

    Сюда попадают, только если блок действия не нарисовался: на резюме место
    под него держится заранее, и по расчёту такого не бывает; на странице
    региона блок стоит выше списка тем и не помещается лишь на листе, уже
    занятом плитками и абзацем. Страховка печатает фразу простым абзацем; не
    вышло и это — потеря называется вслух и останавливает выдачу, а не остаётся
    немой: абзац её уже не несёт.

    Высота сверяется до вызова `ctx.body`: у того пол в 200 000 EMU, и текст был
    бы нарисован даже там, где места нет, — ниже границы содержимого.
    """
    text = _safe(advice)
    room = max(0, CONTENT_BOTTOM - y)
    needed = measure_text_height(text, CONTENT_W, FS_BODY, line_spacing=1.2)
    if needed <= room:
        drawn_to = ctx.body(text, y, max_h=room)
        if drawn_to != y and not ctx.last_body["clipped"]:
            return drawn_to
        y = drawn_to
    record_text_layout(
        page=ctx.page,
        name=f"orion_advice_dropped_p{ctx.page}",
        role="text",
        font_family=FONT,
        font_size_pt=FS_BODY,
        box_width=CONTENT_W,
        box_height=0,
        available_height=room,
        required_height=needed,
        measured_lines=0,
        text_length=len(text),
        clipped=True,
        dropped_lines=1,
    )
    return y


def render_action_block(
    ctx: _Ctx, label: str, y: int, *, max_h: int, heading: str = "Действие"
) -> int:
    """«Действие» на сцене: зелёный подзаголовок и текст рекомендации.

    Обрубок не печатается. Карточка «Действие» со словом «Проверить» вместо
    рекомендации занимает полосу во всю ширину и не сообщает ничего — правило
    из `content_card(skip_if_stub=True)`, которое здесь пришлось бы потерять
    вместе с карточкой.
    """
    text = _safe(label)
    if not text:
        return y
    avail = min(max_h, CONTENT_BOTTOM - y)
    if avail < 420_000:
        return y
    body_avail = avail - 260_000
    fitted = _fit_text_to_height(text, CONTENT_W, FS_BODY, body_avail)
    if len(fitted) < min(60, int(len(text) * 0.5)):
        return y
    y = stage_heading(ctx, heading, y)
    return ctx.body(text, y, max_h=body_avail) + 40_000


def alternating_color(index: int) -> RGBColor:
    """Чередование зелёного и фиолетового у маркеров — ритм страницы cleeq."""
    return ACCENT if index % 2 == 0 else VIOLET
