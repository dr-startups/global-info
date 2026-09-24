"""Per-template slide dispatch (_render_slide)."""

from __future__ import annotations

import io
import re
from typing import Any

from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR
from pptx.util import Emu, Pt

try:
    from PIL import Image, ImageEnhance, ImageFilter
except ImportError:  # pragma: no cover
    Image = None  # type: ignore
    ImageEnhance = None  # type: ignore
    ImageFilter = None  # type: ignore

from .common import (
    ACCENT,
    BULLET_GLYPH,
    FS_CARD_TITLE,
    FS_COVER,
    FS_LEAD,
    FS_SUBTITLE,
    BODY_COLOR,
    CARD_BG,
    CARD_BORDER,
    CONTENT_BOTTOM,
    CONTENT_W,
    COVER_BG,
    COVER_SUBTITLE,
    EMU_PER_PT,
    FONT,
    FS_BODY,
    FS_CAPTION,
    FS_SECTION,
    FS_TITLE,
    MARGIN_X,
    MUTED_COLOR,
    NAVY,
    SLIDE_H,
    TONE_RISK,
    WHITE,
    _Ctx,
    _clip_words,
    _embed_cover_portrait,
    _embed_image,
    _first_visual_asset,
    _resolve_image_bytes,
    _safe,
    _safe_preserve_breaks,
    _wrapped_line_count,
    disable_shape_shadow,
    record_text_layout,
)
from .executive import (
    _render_executive_dashboard,
    _render_profile_overview,
    _render_risk_matrix_grid,
)
from .layout_cleeq import (
    alternating_color,
    content_stage,
    narrative_without_advice,
    print_moved_advice,
    render_action_block,
    render_metric_rows,
)
from .visual import (
    _add_search_table,
    _render_kpi_cards,
    _render_status_badge,
    _render_visual_with_sidebar,
    _tone_value_color,
    _render_ai_answers_page,
)

#: Потолок вводного абзаца страницы выдачи и отбивка под ним.
#:
#: Ёмкость листа (`maxTableRowsPerSlide` шаблона `serp-table`) выведена от
#: **объявленного** потолка, а не от фактической высоты абзаца: `ctx.body`
#: за `max_h` выйти не может, поэтому рост абзаца ёмкость не двигает. Предел
#: подъёма — 1 157 200 EMU: выше бюджет строк становится меньше четырёх худших
#: законных пар «строка результата + полоса адреса», и на каждой таблице
#: выдачи прибавляется страница. Обоснование целиком — в комментарии к
#: `maxTableRowsPerSlide` и в `docs/ENGINEERING.md` §8.
#:
#: Число объявлено здесь один раз: смок `renderer/smoke_search_table_layout.py`
#: импортирует его, а не повторяет. Копия числа зеленела бы и врала вместе с
#: оригиналом.
SEARCH_TABLE_INTRO_MAX_H = 1_000_000
SEARCH_TABLE_INTRO_GAP = 40_000

#: Потолок абзаца страницы региона: с плитками метрик и без них.
METRICS_NARRATIVE_MAX_H = 1_500_000
METRICS_NARRATIVE_MAX_H_NO_TILES = 1_700_000


#: Шаблоны деки, чьи страницы печатают чужой текст без кавычек. Страница
#: AI-ответов без картинки идёт прозаическим макетом, и узнать её можно только
#: по идентификатору шаблона деки — тем же признаком, которым её узнаёт ветка
#: `orion_golden_surface_panel`.
VERBATIM_TEMPLATE_IDS = frozenset({"ai-overview"})


#: Серые полос бренда на тёмном листе (шаг 0151): вместо фиолетового и голубого
#: — на листе один акцент, зелёный.
ART_GREY = RGBColor(0x4A, 0x4A, 0x4A)
ART_GREY_DARK = RGBColor(0x2E, 0x2E, 0x2E)


def _draw_cleeq_cover_art(ctx: _Ctx) -> None:
    """Абстрактные полосы бренда справа — обложка без портрета субъекта.

    Полосы держатся в границах листа и внутри боковых полей. В исходной ветке
    они уходили за правый край (навылет), и на эталонной деке это давало пять
    `out-of-bounds` от инспектора геометрии, две «пустые панели» от ручной
    визуальной проверки и два дефекта растровой — то есть обложка одна валила
    три приёмочных ворот из девятнадцати. Обрез — приём хороший, но он должен
    быть решением, объявленным проверке, а не её обходом.
    """
    right = 11_350_000
    bands = [
        (7_100_000, 520_000, right - 7_100_000, 2_300_000, ACCENT),
        (7_900_000, 1_450_000, right - 7_900_000, 2_400_000, ART_GREY),
        (8_700_000, 2_500_000, right - 8_700_000, 1_700_000, ART_GREY_DARK),
        (7_450_000, 3_800_000, right - 7_450_000, 1_150_000, ACCENT),
        (8_900_000, 4_600_000, right - 8_900_000, 1_450_000, ART_GREY),
    ]
    for x, y, w, h, color in bands:
        shape = ctx.slide.shapes.add_shape(5, Emu(x), Emu(y), Emu(w), Emu(h))
        shape.fill.solid()
        shape.fill.fore_color.rgb = color
        shape.line.fill.background()
        try:
            shape.adjustments[0] = 0.5
        except Exception:  # noqa: BLE001
            pass


#: Высота полосы на разделителе: меньше 10 % листа (731 520 EMU), иначе ручная
#: визуальная проверка сочла бы полосу пустой карточкой.
DIVIDER_BAND_H = 260_000

#: Карточки содержания (шаг 0150): потолок высоты ряда, чтобы два-три раздела
#: не раздувались на весь лист, и отбивка между карточками.
TOC_ROW_MAX_H = 1_000_000
TOC_ROW_GAP = 120_000
#: Низ последней карточки — выше низа сцены остальных страниц (105 000 над
#: границей контента) ещё на 120 000: у карточки мягкая тень LibreOffice, а
#: растровая проверка не терпит чернил ниже `INK_BOTTOM`.
TOC_BOTTOM_RESERVE = 225_000


#: Панель снимка выдачи на разделителе (шаг 0151): правая часть листа в
#: пределах боковых полей (правый край — как у полос обложки) и выше низа сцены.
#: Растровая проверка не терпит чернил ближе 288 000 EMU к краю листа и ниже
#: `INK_BOTTOM`, а угол листа, по которому она берёт фон, остаётся тёмным.
DIVIDER_PHOTO_X = 6_900_000
DIVIDER_PHOTO_RIGHT = 11_350_000
DIVIDER_PHOTO_TOP = 380_000
DIVIDER_PHOTO_BOTTOM = 6_380_000
#: Снимок на разделителе — фактура раздела, а не материал для чтения: размыт до
#: нечитаемого (иначе имена и адреса выдачи спорят с титулом) и затемнён так, что
#: белый фон выдачи уходит в серый ~#434343 и белый титул рядом читается.
DIVIDER_PHOTO_BRIGHTNESS = 0.26
DIVIDER_PHOTO_BLUR_PX = 2.4


def _divider_photo_png(slide: dict[str, Any], assets: dict[str, dict[str, Any]]) -> bytes | None:
    """Снимок выдачи региона разделителя — ч/б, затемнённый, под размер панели.

    Регион — первая часть ключа раздела (`RU_PROFILE` → `ru`), снимок — первый
    ассет вида `serp_snapshot` с тем же префиксом: так их называет приложение
    (`ru_provider_serp_…`, `uae_provider_serp_…`). Снимка с байтами нет — `None`,
    и разделитель рисует полосы бренда: пустое честнее выдуманного.
    """
    if Image is None or ImageEnhance is None or ImageFilter is None:
        return None
    region = str(slide.get("sectionKey") or "").split("_", 1)[0].lower()
    if not region:
        return None
    prefix = f"{region}_"
    ratio = (DIVIDER_PHOTO_RIGHT - DIVIDER_PHOTO_X) / (DIVIDER_PHOTO_BOTTOM - DIVIDER_PHOTO_TOP)
    for ref, asset in assets.items():
        if not str(ref).startswith(prefix) or str(asset.get("kind") or "") != "serp_snapshot":
            continue
        raw = _resolve_image_bytes(asset)
        if not raw:
            continue
        try:
            im = Image.open(io.BytesIO(raw)).convert("L")
        except Exception:  # noqa: BLE001
            continue
        iw, ih = im.size
        if iw <= 0 or ih <= 0:
            continue
        # Кадр — сверху: там строка поиска и первые результаты, узнаваемая часть.
        if iw / ih > ratio:
            cw = int(ih * ratio)
            left = (iw - cw) // 2
            im = im.crop((left, 0, left + cw, ih))
        else:
            im = im.crop((0, 0, iw, int(iw / ratio)))
        width_px = 900
        im = im.resize((width_px, max(1, int(width_px / ratio))))
        im = im.filter(ImageFilter.GaussianBlur(radius=DIVIDER_PHOTO_BLUR_PX))
        im = ImageEnhance.Brightness(im).enhance(DIVIDER_PHOTO_BRIGHTNESS)
        buf = io.BytesIO()
        im.convert("RGB").save(buf, "PNG")
        return buf.getvalue()
    return None


def _draw_divider_art(ctx: _Ctx, slide: dict[str, Any], assets: dict[str, dict[str, Any]]) -> bool:
    """Правая часть тёмного разделителя; `True`, если стоит снимок выдачи.

    Шаг 0151: разделитель-обложка — затемнённый снимок выдачи своего региона
    панелью справа, как фото раздела у эталона-ориентира, но из наших же данных.
    Имя `orion_bg_*` — инспектор геометрии считает панель фоном, и титул поверх
    неё пересечением не считается.

    Снимка нет — полосы бренда (шаг 0150) в правом верхнем поле: над титулом
    (hero — с y = 2 250 000, обычный — с 2 800 000), кончаются на 1 860 000.
    Правый край — 11 350 000, как у обложки. `decor` в имени — инспектор
    геометрии считает полосу оформлением, а не блоком.
    """
    photo = _divider_photo_png(slide, assets)
    if photo:
        pic = ctx.slide.shapes.add_picture(
            io.BytesIO(photo),
            Emu(DIVIDER_PHOTO_X),
            Emu(DIVIDER_PHOTO_TOP),
            width=Emu(DIVIDER_PHOTO_RIGHT - DIVIDER_PHOTO_X),
            height=Emu(DIVIDER_PHOTO_BOTTOM - DIVIDER_PHOTO_TOP),
        )
        try:
            pic.name = f"orion_bg_divider_p{ctx.page}"
        except Exception:  # noqa: BLE001
            pass
        return True
    right = 11_350_000
    bands = [
        (7_300_000, 520_000, ACCENT),
        (8_400_000, 880_000, ART_GREY),
        (9_300_000, 1_240_000, ART_GREY_DARK),
        (8_000_000, 1_600_000, ACCENT),
    ]
    for index, (x, y, color) in enumerate(bands, start=1):
        shape = ctx.slide.shapes.add_shape(5, Emu(x), Emu(y), Emu(right - x), Emu(DIVIDER_BAND_H))
        try:
            shape.name = f"orion_decor_divider_band_{index}_p{ctx.page}"
        except Exception:  # noqa: BLE001
            pass
        shape.fill.solid()
        shape.fill.fore_color.rgb = color
        shape.line.fill.background()
        disable_shape_shadow(shape)
        try:
            shape.adjustments[0] = 0.5
        except Exception:  # noqa: BLE001
            pass
    return False


#: Сколько места держится под рекомендацией и футнотом, когда над ними стоит
#: список строк. Числа те же, которыми ограничена карточка «Что проверить» и
#: подпись под ней: список не вправе занять их место — иначе рекомендация
#: молча ужимается до обрубка, а методология не печатается вовсе.
#:
#: `FOOTNOTE_RESERVE` — замер: подпись 9 pt в 300 знаков (потолок клипа) занимает
#: 363 697 EMU. Этой же величиной проверяется, есть ли место под футнот: пока
#: резерв и порог были разными числами (360 000 и 400 000), футнот мог не
#: напечататься на полном листе — и молча.
ACTION_CARD_MAX_H = 1_100_000
CARD_GAP = 110_000
FOOTNOTE_RESERVE = 380_000


def _render_status_cards(
    ctx: _Ctx,
    slide: dict[str, Any],
    title: str,
    narrative: str,
    bullets: list[str],
    *,
    status_title: str,
    bullets_as_card: bool,
) -> None:
    """Карточная страница: статус, содержимое, рекомендация, футнот методологии.

    Один макет на два шаблона — пустое состояние поверхности и страницу
    фактической проверки Википедии. Разница ровно одна: буллеты печатаются
    карточкой «Что это означает» (пустое состояние объясняет, чем плохо
    отсутствие материалов) или списком строк выдачи. Копии геометрии не
    заводится намеренно: методология и рекомендация обязаны печататься на обеих
    страницах, а два одинаковых макета расходятся с первой же правкой.
    """
    ctx.light_bg()
    y = ctx.title(title, 320000, NAVY)
    # Карточка с одним заголовком — это пустой озаглавленный блок, и приёмка
    # считает его дефектом. На странице-продолжении нарратива нет по построению
    # (он принадлежит первой странице блока), поэтому карточка там не рисуется.
    if narrative:
        # PDF-36 D.3 — cards height-fit with font step-down; no char starvation.
        y = ctx.content_card(
            title=status_title,
            text=narrative,
            x=MARGIN_X,
            y=y,
            width=CONTENT_W,
            min_h=380_000,
            max_h=1_700_000,
            tone="accent",
            title_size=11,
            body_size=FS_BODY,
        )
        y += CARD_GAP
    actions = [a for a in (slide.get("actions") or []) if isinstance(a, dict)]
    methodology = _safe(slide.get("methodologyNote") or "")
    source_note = _safe(slide.get("sourceNote") or "")
    footnote = " ".join(x for x in (methodology, source_note) if x)
    if bullets and bullets_as_card:
        y = ctx.content_card(
            title="Что это означает",
            text="\n".join(bullets[:4]),
            x=MARGIN_X,
            y=y,
            width=CONTENT_W,
            min_h=360_000,
            max_h=2_200_000,
            tone="neutral",
            title_size=11,
            body_size=11,
        )
        y += CARD_GAP
    elif bullets:
        reserved = (ACTION_CARD_MAX_H + CARD_GAP if actions else 0) + (
            FOOTNOTE_RESERVE if footnote else 0
        )
        y = ctx.bullets(bullets, y, max_items=8, bottom=CONTENT_BOTTOM - reserved)
        y += CARD_GAP
    if actions:
        y = ctx.content_card(
            title="Что проверить",
            text=_safe(actions[0].get("label")),
            x=MARGIN_X,
            y=y,
            width=CONTENT_W,
            min_h=320_000,
            max_h=ACTION_CARD_MAX_H,
            tone="warn",
            title_size=11,
            body_size=11,
        )
        y += CARD_GAP
    if not footnote:
        return
    if y <= CONTENT_BOTTOM - FOOTNOTE_RESERVE:
        ctx.body(
            _clip_words(footnote, 300),
            y,
            max_h=CONTENT_BOTTOM - y - 60_000,
            color=MUTED_COLOR,
            font_size=9,
        )
        return
    # Ненапечатанная методология — потеря содержимого, а не мелочь вёрстки: на
    # странице проверки она и есть предмет страницы. На ветке со списком место
    # под неё держит резерв, и сюда попасть нельзя; на карточной ветке карточки
    # могут съесть лист — тогда об этом обязано быть слышно.
    record_text_layout(
        page=ctx.page,
        name=f"orion_footnote_dropped_p{ctx.page}",
        role="footnote",
        font_family=FONT,
        font_size_pt=9,
        box_width=CONTENT_W,
        box_height=0,
        available_height=max(0, CONTENT_BOTTOM - y),
        required_height=FOOTNOTE_RESERVE,
        measured_lines=0,
        text_length=len(footnote),
        clipped=True,
        measurement_uncertain=False,
        dropped_lines=1,
    )


def _render_slide(ctx: _Ctx, slide: dict[str, Any], assets: dict[str, dict[str, Any]]) -> None:
    template = str(slide.get("template") or "")
    # Level 2.5 — named pre-built layout variant picked by the GPT composer.
    # Validated upstream (TS registry); unknown values fall back to default.
    variant = str(slide.get("layoutVariant") or "")
    title = _safe(slide.get("title") or "ORION")
    # Абзацы страницы — её структура: приложение отдаёт подзаголовок, абзац
    # построителя, прозу находки и рекомендацию строками. `_safe` схлопывал
    # перевод строки, и до `ctx.body` абзац доходил стеной. Макет, чей абзац
    # откалиброван как один (страница выдачи), схлопывает его сам и явно.
    narrative = _safe_preserve_breaks(slide.get("narrative") or "")
    # PDF-47 — keep structured theme newlines; _safe() collapses them and then
    # nested «…«…»» quotes cannot reflow → theme-only stubs («Офшоры»).
    bullets = [
        _safe_preserve_breaks(b)
        for b in slide.get("bullets") or []
        if _safe_preserve_breaks(b)
    ]
    refs = slide.get("assetRefs") or []
    primary = assets.get(str(refs[0])) if refs else None

    if template == "orion_golden_cover":
        # Обложка cleeq: чернильный лист, словесный знак, зелёный надзаголовок,
        # имя субъекта крупно, метаданные и строка-подпись. Справа — портрет
        # субъекта из выдачи, а если превью нет, абстрактные полосы бренда.
        #
        # Полотна под подписями больше нет (шаг 0151): портрет стоит правее
        # 6 830 000 EMU, а полотно кончалось на 6 200 000 — подписи оно не
        # прикрывало, зато его тень по умолчанию печаталась вертикальной
        # полосой посреди листа (тест 24.09.2026).
        ctx.dark_bg()
        portrait = _first_visual_asset(list(refs), assets) or primary
        if not _embed_cover_portrait(ctx, portrait):
            _draw_cleeq_cover_art(ctx)
        brand = ctx.slide.shapes.add_textbox(
            Emu(MARGIN_X), Emu(420_000), Emu(4_800_000), Emu(320_000)
        )
        br = brand.text_frame.paragraphs[0].add_run()
        br.text = "cleeq"
        br.font.name = FONT
        br.font.bold = True
        br.font.size = Pt(FS_SUBTITLE)
        br.font.color.rgb = WHITE
        hero = (title or "Цифровой профиль").strip()
        for sep in (" — ", " – ", " - "):
            if sep in hero:
                hero = hero.split(sep, 1)[-1].strip() or hero
                break
        kicker = ctx.slide.shapes.add_textbox(
            Emu(MARGIN_X), Emu(3_250_000), Emu(5_800_000), Emu(280_000)
        )
        kr = kicker.text_frame.paragraphs[0].add_run()
        kr.text = "Цифровой профиль"
        kr.font.name = FONT
        kr.font.bold = True
        kr.font.size = Pt(FS_BODY)
        kr.font.color.rgb = ACCENT
        name_box = ctx.slide.shapes.add_textbox(
            Emu(MARGIN_X), Emu(3_600_000), Emu(5_900_000), Emu(1_400_000)
        )
        ntf = name_box.text_frame
        ntf.word_wrap = True
        nr = ntf.paragraphs[0].add_run()
        # Имя капсом (шаг 0151). Рамка держит две строки 36 pt; капс шире, и
        # длинное ФИО в три строки легло бы на подзаголовок — тогда ступень ниже.
        name_text = _safe(hero).upper()
        name_size = FS_COVER
        if _wrapped_line_count(name_text, 5_900_000, name_size, bold=True) > 2:
            name_size = FS_TITLE
        nr.text = name_text
        nr.font.name = FONT
        nr.font.bold = True
        nr.font.size = Pt(name_size)
        nr.font.color.rgb = WHITE
        ctx.body(
            narrative or "Конфиденциально. Подготовлено для внутреннего использования клиента.",
            5_050_000,
            max_h=600_000,
            color=COVER_SUBTITLE,
            w=5_800_000,
            font_size=FS_SUBTITLE,
        )
        # Строка-подпись — зелёным по листу, без серой подложки (решение
        # владельца, тест 24.09.2026): подложка читалась отдельной кнопкой.
        # Строка держится над границей контентной области: ниже неё чернил быть
        # не должно, и растровая проверка ловит это по отрисованной странице.
        chip_t = ctx.slide.shapes.add_textbox(
            Emu(MARGIN_X), Emu(5_810_000), Emu(3_400_000), Emu(240_000)
        )
        ctr = chip_t.text_frame.paragraphs[0].add_run()
        ctr.text = "Аудит · стратегия · конфиденциально"
        ctr.font.name = FONT
        ctr.font.size = Pt(FS_BODY)
        ctr.font.color.rgb = ACCENT
        return

    if template == "orion_golden_toc":
        # Содержание cleeq (шаг 0150): мятный лист и по белой карточке на
        # раздел — номер зелёным или фиолетовым, название чернилами. Карточки
        # делят высоту листа поровну: при прежнем потолке ряда 560 000 пять
        # разделов занимали верхнюю половину листа, и нижняя пустовала. Белой
        # сцены под карточками нет — белое на белом не читается как отдельный
        # блок (то же правило, что у `orion_golden_executive_card`).
        ctx.light_bg()
        y = ctx.title("Содержание отчёта", 320_000, NAVY, FS_SECTION)
        entries = [
            _clip_words(b, 110)
            for b in (bullets or ["Резюме", "Россия", "ОАЭ", "Compliance", "LexisNexis", "Рекомендации"])
        ][:10]
        top = y + 80_000
        bottom = CONTENT_BOTTOM - TOC_BOTTOM_RESERVE
        count = max(1, len(entries))
        row_h = min(TOC_ROW_MAX_H, (bottom - top - TOC_ROW_GAP * (count - 1)) // count)
        ry = top
        for i, entry in enumerate(entries, start=1):
            ctx.card(ry, h=row_h)
            num = ctx.slide.shapes.add_textbox(
                Emu(MARGIN_X + 180_000), Emu(ry), Emu(700_000), Emu(row_h)
            )
            num.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
            nr = num.text_frame.paragraphs[0].add_run()
            nr.text = f"{i:02d}"
            nr.font.name = FONT
            nr.font.bold = True
            nr.font.size = Pt(FS_LEAD)
            nr.font.color.rgb = alternating_color(i - 1)
            box = ctx.slide.shapes.add_textbox(
                Emu(MARGIN_X + 940_000),
                Emu(ry),
                Emu(CONTENT_W - 1_120_000),
                Emu(row_h),
            )
            tf = box.text_frame
            tf.word_wrap = True
            tf.vertical_anchor = MSO_ANCHOR.MIDDLE
            r = tf.paragraphs[0].add_run()
            r.text = entry
            r.font.name = FONT
            r.font.bold = True
            r.font.size = Pt(FS_SUBTITLE)
            r.font.color.rgb = NAVY
            ry += row_h + TOC_ROW_GAP
        return

    if template == "orion_golden_executive_dashboard":
        _render_executive_dashboard(ctx, slide, title)
        return

    if template == "orion_golden_risk_matrix_grid":
        _render_risk_matrix_grid(ctx, slide, title)
        return

    if template == "orion_golden_profile_overview":
        _render_profile_overview(ctx, slide, title)
        return

    if template == "orion_golden_executive_card":
        # Страница-документ cleeq: заголовок снаружи, всё содержимое — на одной
        # белой сцене. Карточек внутри сцены нет: белое на белом не читается как
        # отдельный блок, и вместо иерархии выходит рябь из рамок.
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY, FS_SECTION)
        metrics = [m for m in (slide.get("metrics") or []) if isinstance(m, dict)]
        if metrics:
            metrics_bottom = render_metric_rows(
                ctx, metrics, MARGIN_X, y, CONTENT_W, tone_value_color=_tone_value_color
            )
            y = metrics_bottom + 140_000
        content_stage(ctx, y, top=metrics_bottom + 40_000 if metrics else None)
        narr = narrative.strip()
        if variant == "accent-headline" and narr:
            # Accent-headline: the lead sentence leads the page, the rest of the
            # narrative follows, then the detail bullets.
            sentences = re.split(r"(?<=[.!?…])\s+", narr)
            lead = sentences[0] if sentences else narr
            rest = " ".join(sentences[1:]).strip()
            y = ctx.body(lead, y, max_h=1_100_000, bold=True) + 60_000
            if rest:
                y = ctx.body(
                    rest,
                    y,
                    max_h=min(2_400_000, CONTENT_BOTTOM - y - (1_200_000 if bullets else 100_000)),
                ) + 60_000
            if bullets:
                ctx.bullets(bullets, y, max_items=6, max_chars=900)
            return
        if narr and not bullets:
            ctx.body(narr, y, max_h=min(3_200_000, CONTENT_BOTTOM - y - 100_000), bold=True)
            return
        if narr:
            y = ctx.body(
                narr,
                y,
                max_h=min(2_000_000, CONTENT_BOTTOM - y - (1_200_000 if bullets else 100_000)),
                bold=True,
            ) + 60_000
        if bullets:
            ctx.bullets(bullets, y, max_items=6, max_chars=900)
        return

    if template == "orion_golden_risk_matrix":
        _render_risk_matrix_grid(ctx, slide, title or "Матрица рисков")
        return

    if template == "orion_golden_region_divider":
        ctx.dark_bg()
        # Графика — в обеих ветках: и hero, и обычный разделитель пустовали
        # справа и сверху одинаково.
        has_photo = _draw_divider_art(ctx, slide, assets)
        if variant == "hero":
            # Разделитель cleeq: зелёный столб, серая засечка, крупный титул
            # капсом (шаг 0151).
            bar = ctx.slide.shapes.add_shape(
                5, Emu(MARGIN_X), Emu(2_200_000), Emu(140_000), Emu(2_200_000)
            )
            bar.fill.solid()
            bar.fill.fore_color.rgb = ACCENT
            bar.line.fill.background()
            try:
                bar.adjustments[0] = 0.5
            except Exception:  # noqa: BLE001
                pass
            accent = ctx.slide.shapes.add_shape(
                5, Emu(MARGIN_X + 220_000), Emu(2_200_000), Emu(90_000), Emu(700_000)
            )
            accent.fill.solid()
            accent.fill.fore_color.rgb = ART_GREY
            accent.line.fill.background()
            text_x = MARGIN_X + 420_000
            # Снимок стоит справа — текст держится левее панели: лид поверх
            # фактуры читался бы хуже титула. Высота лида растёт в той же мере,
            # в какой сузилась колонка, — ёмкость остаётся прежней.
            text_w = DIVIDER_PHOTO_X - 250_000 - text_x if has_photo else CONTENT_W - 420_000
            hero_title = _safe(title).upper()
            size = FS_COVER
            if _wrapped_line_count(hero_title, text_w, size, bold=True) > 2:
                size = FS_TITLE
            lines = _wrapped_line_count(hero_title, text_w, size, bold=True)
            title_h = int(lines * size * EMU_PER_PT * 1.2)
            box = ctx.slide.shapes.add_textbox(
                Emu(text_x), Emu(2_250_000), Emu(text_w), Emu(max(1_100_000, title_h))
            )
            tf = box.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            r = p.add_run()
            r.text = hero_title
            r.font.name = FONT
            r.font.bold = True
            r.font.size = Pt(size)
            r.font.color.rgb = WHITE
            if narrative:
                lead_y = max(3_500_000, 2_250_000 + title_h + 150_000)
                ctx.body(
                    narrative,
                    lead_y,
                    max_h=min(2_700_000, DIVIDER_PHOTO_BOTTOM - lead_y) if has_photo else 1_500_000,
                    color=COVER_SUBTITLE,
                    font_size=FS_SUBTITLE,
                    x=text_x,
                    w=text_w,
                )
            return
        if has_photo:
            # Титул держится левее панели снимка: поверх фактуры он читался бы
            # хуже. Капс 36 pt в две строки не встал — ступень ниже.
            width = DIVIDER_PHOTO_X - 250_000 - MARGIN_X
            caps = _safe(title).upper()
            size = FS_COVER
            if _wrapped_line_count(caps, width - 200_000, size, bold=True) > 2:
                size = FS_TITLE
            ctx.title(title, 2800000, WHITE, size, width=width)
            return
        ctx.title(title, 2800000, WHITE, FS_COVER)
        return

    if template == "orion_golden_metrics_dashboard":
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY, FS_SECTION)
        badge = slide.get("statusBadge") if isinstance(slide.get("statusBadge"), dict) else None
        if badge:
            y = _render_status_badge(ctx, badge, MARGIN_X, y, CONTENT_W) + 80_000
        # Страница метрик cleeq: ключевая цифра ведёт страницу, остальное лежит
        # на одной сцене. Вариант `kpi-first` отдельной веткой больше не нужен —
        # цифры ведут страницу всегда, и это ровно то, ради чего он заводился.
        #
        # Порядок содержимого прежний: метрики → нарратив → действие → темы.
        # Ёмкость тоже прежняя: ряд метрик той же высоты, что раньше, а сцена
        # рисуется под текстом и его не двигает.
        metrics = [m for m in (slide.get("metrics") or []) if isinstance(m, dict)]
        if metrics:
            # До шести метрик — один ряд; семь — два ряда 4 + 3 (шаг 0101).
            metrics_bottom = render_metric_rows(
                ctx, metrics, MARGIN_X, y, CONTENT_W, tone_value_color=_tone_value_color
            )
            y = metrics_bottom + 140_000
        content_stage(ctx, y, top=metrics_bottom + 40_000 if metrics else None)
        # Рекомендация печатается один раз — под «Действие». Проза находки кладёт
        # её и последним абзацем страницы; дословный повтор из абзаца снимается,
        # и блок действия после этого обязан напечататься (см. ниже).
        actions = [a for a in (slide.get("actions") or []) if isinstance(a, dict)]
        advice = _safe(actions[0].get("label")) if actions else ""
        narrative_paras, advice_moved = narrative_without_advice(narrative.split("\n"), advice)
        narrative = "\n".join(p for p in narrative_paras if p.strip())
        if narrative:
            # Потолок поднят вместе с абзацами (шаг 0098): прежние 900 000 были
            # впритык одному абзацу в четыре строки (замер: 0,88 потолка), и
            # с отбивками между абзацами текст ушёл бы в понижение кегля. Лишнего
            # абзац не занимает — рамка по мере, а список под ним набирается по
            # мере же: не влезшие блоки уезжают на продолжение.
            #
            # Жирным абзац больше не печатается: вывод страницы региона — её
            # заголовок («Россия: в выдаче есть материалы повышенного внимания»),
            # а абзац под плитками — факты. Жирный целиком, он был стеной в три
            # предложения; теперь в нём выделены ярлыки и числа, и глаз находит
            # «Подтверждённых тем: 5» без чтения подряд.
            y = ctx.body(
                narrative,
                y,
                max_h=METRICS_NARRATIVE_MAX_H if metrics else METRICS_NARRATIVE_MAX_H_NO_TILES,
            ) + 70_000
        # Статусная строка страницы региона: доля негатива среди прочитанного и
        # база, по которой она посчитана. Своей строкой, а не хвостом нарратива:
        # подгонка по высоте отбрасывает предложения с конца молча, и на живом
        # прогоне так исчезал целый абзац.
        status_note = _safe(slide.get("statusNote") or "")
        if status_note:
            y = ctx.body(
                status_note,
                y,
                max_h=500_000,
                color=MUTED_COLOR,
                font_size=FS_CAPTION,
            ) + 60_000
        # Без дубля блок по-прежнему уступает место темам на тесном листе: абзац
        # рекомендацию уже несёт. Снятая из абзаца — печатается безусловно.
        if advice and (advice_moved or not bullets or (CONTENT_BOTTOM - y) > 1_800_000):
            drawn_to = render_action_block(ctx, advice, y, max_h=1_000_000)
            if advice_moved and drawn_to == y:
                drawn_to = print_moved_advice(ctx, advice, y)
            y = drawn_to
        if bullets:
            # Потолок читаемости, а не ёмкости: сколько блоков влезает, решает
            # мерка высоты, приведённая к тому, что рисуется (шаг 16, 07.6).
            ctx.bullets(bullets, y, max_items=6, max_chars=900)
        return

    if template == "orion_golden_serp_screenshot":
        _render_visual_with_sidebar(ctx, slide, assets, title)
        return

    if template == "orion_golden_image_grid":
        if slide.get("visualAnalysis") or slide.get("clientTakeaway"):
            _render_visual_with_sidebar(ctx, slide, assets, title)
            return
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY)
        if len(refs) == 1:
            primary_grid = assets.get(str(refs[0])) if refs else None
            if primary_grid and _resolve_image_bytes(primary_grid):
                _embed_image(ctx, primary_grid, y + 60000, h=5_200_000)
                cap = _safe(primary_grid.get("caption") or "")
                if cap:
                    ctx.body(cap, CONTENT_BOTTOM - 380000, max_h=320000, color=MUTED_COLOR)
                return
        cols = 3
        cell_w = CONTENT_W // 3 - 80_000
        cell_h = 1_600_000
        gap = 120000
        max_rows = max(1, int((CONTENT_BOTTOM - y + gap) // (cell_h + gap)))
        max_cells = max_rows * cols
        for idx, ref in enumerate(refs):
            if idx >= max_cells:
                break
            row = idx // cols
            col = idx % cols
            cx = MARGIN_X + col * (cell_w + gap)
            cy = y + row * (cell_h + gap)
            asset = assets.get(str(ref))
            raw = _resolve_image_bytes(asset) if asset else None
            if raw:
                stream = io.BytesIO(raw)
                iw, ih = cell_w, cell_h
                if Image is not None:
                    try:
                        with Image.open(io.BytesIO(raw)) as im:
                            iw, ih = im.size
                    except Exception:
                        pass
                scale = min(cell_w / max(iw, 1), cell_h / max(ih, 1))
                dw, dh = int(iw * scale), int(ih * scale)
                left = cx + (cell_w - dw) // 2
                top = cy + (cell_h - dh) // 2
                ctx.slide.shapes.add_picture(stream, Emu(left), Emu(top), width=Emu(dw), height=Emu(dh))
            else:
                shape = ctx.slide.shapes.add_shape(5, Emu(cx), Emu(cy), Emu(cell_w), Emu(cell_h))
                try:
                    shape.adjustments[0] = 0.05
                except Exception:  # noqa: BLE001
                    pass
                shape.fill.solid()
                shape.fill.fore_color.rgb = CARD_BG
                shape.line.color.rgb = CARD_BORDER
                shape.line.width = Pt(0.75)
                tf = shape.text_frame
                tf.word_wrap = True
                p = tf.paragraphs[0]
                r = p.add_run()
                r.text = _safe((asset or {}).get("title") or "Недоступно")
                r.font.size = Pt(FS_CAPTION)
        return

    if template == "orion_golden_video_cards":
        _render_visual_with_sidebar(ctx, slide, assets, title)
        return

    if template == "orion_golden_knowledge_panel":
        _render_visual_with_sidebar(ctx, slide, assets, title)
        return

    if template == "orion_golden_surface_panel":
        # Страница AI-ответов узнаётся по идентификатору шаблона деки, а не по
        # новому имени макета: старый рендерер в окне деплоя нарисует её как
        # прежде (без текста), а не откажет.
        if str(slide.get("templateId") or "") == "ai-overview":
            _render_ai_answers_page(ctx, slide, assets, title, bullets)
            return
        _render_visual_with_sidebar(ctx, slide, assets, title)
        return

    if template == "orion_golden_lexis_visual_page":
        if slide.get("visualAnalysis") or slide.get("clientTakeaway"):
            _render_visual_with_sidebar(ctx, slide, assets, title)
            return
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY)
        _embed_image(ctx, primary, y + 60000, h=5_200_000)
        return

    if template == "orion_golden_compliance_visual_page":
        # Dow Jones / World-Check approved screenshots — same layout as Lexis visual.
        if slide.get("visualAnalysis") or slide.get("clientTakeaway"):
            _render_visual_with_sidebar(ctx, slide, assets, title)
            return
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY)
        _embed_image(ctx, primary, y + 60000, h=5_200_000)
        return

    if template == "orion_golden_search_table":
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY, FS_SECTION)
        # Сцена под таблицей: строки таблицы лежат на белой плоскости, а не
        # висят на мятном фоне. Её низ — бюджет страницы: он уходит в
        # отрисовщик, а не выбрасывается.
        #
        # `content_stage` отвечает одним значением на два вопроса: низ сцены —
        # или свой вход, если рисовать сцену отказался. Поданное как бюджет,
        # сентинельное значение дало бы ложный CRITICAL с нулевым запасом,
        # поэтому бюджет объявляется только тогда, когда сцена действительно
        # нарисована.
        stage_bottom = content_stage(ctx, y)
        table_bottom_budget = stage_bottom if stage_bottom > y else None
        # Объявленный верх таблицы: он и есть тот верх, от которого выведена
        # ёмкость листа. Считается **до** отрисовки абзаца, потому что дальше
        # `y` станет фактическим — а фактический зависит от длины абзаца,
        # который стадия 2 перепишет уже после мерного прогона.
        table_top_declared = y + SEARCH_TABLE_INTRO_MAX_H + SEARCH_TABLE_INTRO_GAP if narrative else y
        if narrative:
            # Сколько абзаца влезет — решает мера `ctx.body` в пределах
            # объявленного потолка, а не счётчик предложений здесь. Счётчик
            # был вторым редактором, спрятанным в отрисовщике: он выбрасывал
            # «почему важно» и «что проверить» страниц выдачи без записи в
            # телеметрию, а на пустом отборе подставлял выдуманную фразу,
            # которая ни до какого наблюдения не прослеживалась.
            #
            # **Абзац здесь один, а не три, и считать его высоту надо так.**
            # Склейка кладёт «что найдено», «почему важно» и «что проверить»
            # через `\n`, но `_safe` схлопывает любые пробелы, включая перевод
            # строки (`re.sub(r"\s+", " ", …)`), — и `ctx.body` зовёт `_safe`
            # сам, для всех вызывающих. Многоабзацного тела в деке не бывает
            # вообще, отбивки между абзацами в мере нет. Посчитав её (6 pt × 1,18
            # за каждый лишний абзац ≈ 180 000 EMU, почти строка 11 pt), легко
            # решить, что законный состав в потолок не влезает, и поднять
            # потолок до предельных 1 157 200, потратив весь запас бюджета
            # строк на несуществующую проблему. Замер на настоящем листе при
            # потолке 1 000 000: 621 знак прозы 11 pt, 941 знак 9 pt.
            y = ctx.body(
                _safe(narrative),
                y,
                max_h=SEARCH_TABLE_INTRO_MAX_H,
                color=MUTED_COLOR,
            )
            y = y + SEARCH_TABLE_INTRO_GAP
        table = slide.get("table") if isinstance(slide.get("table"), dict) else None
        headers = list((table or {}).get("headers") or [])
        rows = list((table or {}).get("rows") or [])
        groups = list((table or {}).get("groups") or [])
        if not rows and bullets:
            # Fallback: parse bullet lines into a compact table
            headers = ["Поз.", "Домен", "Заголовок", "Риск"]
            parsed: list[list[str]] = []
            for bullet in bullets[:10]:
                raw = _safe(bullet)
                m = re.match(
                    r"^(?:\[([Н·N.])\]\s*)?#?\s*(\d+)\s+([^\s—\-]+)\s*[—\-–]\s*(.+)$",
                    raw,
                )
                if m:
                    mark = "Н" if m.group(1) in ("Н", "N") else "·"
                    parsed.append([m.group(2), m.group(3), _clip_words(m.group(4), 70), mark])
                else:
                    parsed.append(["—", "—", _clip_words(raw, 80), "·"])
            rows = parsed
        if headers and rows:
            # Render every row the (paginated) slide carries — no hidden cap.
            # Keep up to 5 headers so Запрос can be stripped inside the helper
            # without also dropping Статус.
            _add_search_table(
                ctx,
                y,
                headers[:5],
                rows,
                groups,
                bottom=table_bottom_budget,
                declared_top=table_top_declared,
            )
        elif bullets:
            avail = max(400000, CONTENT_BOTTOM - y)
            box = ctx.slide.shapes.add_textbox(Emu(MARGIN_X), Emu(y), Emu(CONTENT_W), Emu(avail))
            tf = box.text_frame
            tf.word_wrap = True
            first = True
            for bullet in bullets[:18]:
                p = tf.paragraphs[0] if first else tf.add_paragraph()
                first = False
                p.space_before = Pt(2)
                p.space_after = Pt(5)
                r = p.add_run()
                clipped = _clip_words(bullet, 240)
                r.text = f"{BULLET_GLYPH} {clipped}"
                r.font.name = FONT
                r.font.size = Pt(FS_BODY)
                r.font.color.rgb = TONE_RISK if clipped.startswith("[Н]") else BODY_COLOR
        return

    if template == "orion_golden_no_data_compact":
        # C.2 — honest empty state as a structured page: status card,
        # "what it means" card, recommendation card, methodology footnote.
        # Карточный абзац остаётся одним абзацем: ёмкость карточки померена по
        # сплошному тексту (`CARD_NARRATIVE_CHAR_BUDGET`), карточки переходят на
        # строки отдельным шагом программы 0095.
        _render_status_cards(
            ctx,
            slide,
            title,
            _safe(narrative) or "Для данного раздела недостаточно подтверждённых данных.",
            bullets,
            status_title="Статус сбора",
            bullets_as_card=True,
        )
        return

    if template == "orion_golden_wikipedia_check":
        # Страница фактической проверки: тот же карточный макет, что и у
        # пустого состояния, но буллеты — строки поисковой выдачи, и печатаются
        # они списком между результатом проверки и рекомендацией.
        _render_status_cards(
            ctx,
            slide,
            title,
            _safe(narrative),
            bullets,
            status_title="Результат проверки",
            bullets_as_card=False,
        )
        return

    if template == "orion_golden_audit_dashboard":
        # ORION regional résumé: themes left-ish via bullets top, KPI counters below.
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY, FS_SECTION)
        if narrative:
            # PDF-36 D.3 — ctx.body height-fits with font step-down; feed it
            # the full text instead of a pre-starved 520-char slice.
            y = ctx.body(_clip_words(narrative, 760), y, max_h=1200000)
            y = y + 80000
        if bullets:
            ctx.bullets(bullets, y, max_items=14, max_chars=340)
        return

    # orion_golden_prose (continuation themes) + default section / appendix
    ctx.light_bg()
    y = ctx.title(title, 280000, NAVY, FS_SECTION)
    content_stage(ctx, y)
    # PDF-36 D.3 / PDF-47 — page bottom is the real budget; theme cards need
    # the full 900-char structured budget (520 starved nested-quote bullets).
    # `_clip_words` схлопывает перевод строки: многоабзацный текст он не режет —
    # его высоту подгоняет `ctx.body`, и абзацы остаются абзацами.
    short_narrative = (
        (narrative if "\n" in narrative else _clip_words(narrative, 900)) if narrative else ""
    )
    if short_narrative and not bullets:
        ctx.body(short_narrative, y, max_h=CONTENT_BOTTOM - y - 100000, bold=True)
        return
    if short_narrative:
        y = ctx.body(short_narrative, y, max_h=1100000, bold=True)
        y = y + 80000
    if bullets:
        ctx.bullets(
            bullets,
            y,
            max_items=9,
            max_chars=900,
            emphasize=str(slide.get("templateId") or "") not in VERBATIM_TEMPLATE_IDS,
        )


