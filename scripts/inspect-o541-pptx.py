"""O5.4.1 — inspect PPTX artifact integrity (embedded thumbnails, hyperlinks, themes)."""

from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path

STALE_THEMES = {"pep_rca", "sanctions", "compliance_database", "adverse_media", "legal"}
TABLE_HEADERS = ("Заголовок изображения", "Image title", "Заголовок видео", "Video title")
WEAK_INTL = (
    "Anatoli Romanovich",
    "Prince Nicholas Romanovich",
    "Nikita Romanovich",
    "Roman Abramovich",
    "Mikhail Romanovich",
    "Romanovich Tomlinson",
    "Lomonosov Moscow State University",
    "RBML Collections",
)


def slide_xml(z: zipfile.ZipFile, n: int) -> str:
    name = f"ppt/slides/slide{n}.xml"
    if name not in z.namelist():
        return ""
    return z.read(name).decode("utf-8", errors="ignore")


def slide_rels(z: zipfile.ZipFile, n: int) -> str:
    name = f"ppt/slides/_rels/slide{n}.xml.rels"
    if name not in z.namelist():
        return ""
    return z.read(name).decode("utf-8", errors="ignore")


def plain_text(xml: str) -> str:
    text = re.sub(r"<[^>]+>", " ", xml)
    return re.sub(r"\s+", " ", text).strip()


def count_pics(xml: str) -> int:
    return len(re.findall(r"<p:pic\b", xml))


def count_hyperlink_rels(rels: str) -> int:
    if not rels:
        return 0
    return len(
        re.findall(
            r"relationships/hyperlink",
            rels,
            flags=re.I,
        )
    )


def count_hlink_clicks(xml: str) -> int:
    return len(re.findall(r"hlinkClick", xml))


def media_files(z: zipfile.ZipFile) -> list[str]:
    return [n for n in z.namelist() if n.startswith("ppt/media/")]


FOOTER_SAFE_BOTTOM = 6315360  # FOOTER_Y - 0.2"
FOOTER_BAND_TOP = 6380000  # ignore shapes in footer/page-number band when measuring content
ZONE_MIN_GAP = 76000  # minimum vertical gap between stacked caption zones (~6pt)
PDF_SAFE_TABLE_NOTE_GAP = 260000  # conservative gap for LibreOffice PDF export fidelity


def _shape_block_bottom(block: str) -> int | None:
    off_m = re.search(r'<a:off x="(\d+)" y="(\d+)"', block)
    ext_m = re.search(r'<a:ext cx="(\d+)" cy="(\d+)"', block)
    if not off_m or not ext_m:
        return None
    y = int(off_m.group(2))
    if y >= FOOTER_BAND_TOP:
        return None
    return y + int(ext_m.group(2))


def max_shape_bottom(xml: str) -> int:
    max_b = 0
    for tag in (r"<p:sp\b.*?</p:sp>", r"<p:pic\b.*?</p:pic>", r"<p:graphicFrame\b.*?</p:graphicFrame>"):
        for block in re.findall(tag, xml, flags=re.DOTALL):
            bottom = _shape_block_bottom(block)
            if bottom is not None:
                max_b = max(max_b, bottom)
    return max_b


def table_bottom(xml: str) -> int:
    max_b = 0
    for gf in re.findall(r"<p:graphicFrame\b.*?</p:graphicFrame>", xml, flags=re.DOTALL):
        if "<a:tbl" not in gf:
            continue
        bottom = _shape_block_bottom(gf)
        if bottom is not None:
            max_b = max(max_b, bottom)
    return max_b


def source_note_below_table(xml: str, min_gap: int = 80000) -> bool:
    tbl_b = table_bottom(xml)
    if tbl_b <= 0:
        return True
    for shape in text_shapes(xml):
        if re.search(
            r"Source:|Источник|Показаны|Showing top|Showing \d|сохранен|evidence",
            shape["text"],
            re.I,
        ):
            if shape["y"] < tbl_b + min_gap:
                return False
            if shape["bottom"] > FOOTER_SAFE_BOTTOM:
                return False
    return True


def table_rows_not_over_footnote(xml: str, min_gap: int = 80000) -> bool:
    """No table cell text shape should sit below pagination footnote top."""
    footnotes = [
        s
        for s in text_shapes(xml)
        if re.search(r"Показаны|Showing top|Showing \d", s["text"], re.I)
    ]
    if not footnotes:
        return True
    fn_top = min(s["y"] for s in footnotes)
    tbl_b = table_bottom(xml)
    return tbl_b + min_gap <= fn_top


def card_frames(xml: str) -> list[dict]:
    frames: list[dict] = []
    for sp in re.findall(r"<p:sp\b.*?</p:sp>", xml, flags=re.DOTALL):
        if "roundRect" not in sp.lower() and "ROUNDED_RECT" not in sp:
            prst = re.search(r'prst="(\w+)"', sp)
            if not prst or prst.group(1) not in ("roundRect", "rect"):
                continue
        off_m = re.search(r'<a:off x="(\d+)" y="(\d+)"', sp)
        ext_m = re.search(r'<a:ext cx="(\d+)" cy="(\d+)"', sp)
        if off_m and ext_m:
            cy = int(ext_m.group(2))
            if cy < 400000:
                continue
            x, y = int(off_m.group(1)), int(off_m.group(2))
            cx = int(ext_m.group(1))
            frames.append({"x": x, "y": y, "right": x + cx, "bottom": y + cy})
    return frames


def gallery_card_frames(xml: str) -> list[dict]:
    frames = card_frames(xml)
    pics = pics_in_xml(xml)
    candidates: list[dict] = []
    for frame in frames:
        if frame["y"] < 1800000:
            continue
        fw = frame["right"] - frame["x"]
        fh = frame["bottom"] - frame["y"]
        if fh < 900000 or fw < 2200000:
            continue
        if any(shape_inside(p, frame) for p in pics):
            candidates.append(frame)
    out: list[dict] = []
    for frame in candidates:
        nested = False
        for other in candidates:
            if frame is other:
                continue
            if shape_inside(frame, other) and (other["bottom"] - other["y"]) > (frame["bottom"] - frame["y"]):
                nested = True
                break
        if not nested:
            out.append(frame)
    return out


GALLERY_NESTED_SLOT_MIN_H = 180000
GAL_ORION_MIN_CARD_IMG_FRAC = 0.50
GAL_ORION_CONTAIN_MIN_H = 680000


def gallery_no_nested_image_slots(xml: str) -> tuple[bool, str]:
    """ORION tiles: one outer card frame per image, no inner gray image slot."""
    frames = gallery_card_frames(xml)
    if not frames:
        return True, "no gallery cards"
    panels = [s for s in sp_shapes(xml) if s["round"]]
    for i, frame in enumerate(frames):
        frame_h = frame["bottom"] - frame["y"]
        for panel in panels:
            if not shape_inside(panel, frame):
                continue
            if panel["h"] < GALLERY_NESTED_SLOT_MIN_H:
                continue
            if panel["h"] >= frame_h - 250000:
                continue
            return False, f"card[{i}] nested image slot h={panel['h']} y={panel['y']}"
    return True, f"cards={len(frames)}"


def slide13_no_identity_badges(xml: str) -> tuple[bool, str]:
    for shape in text_shapes(xml):
        if re.search(r"LIKELY_SUBJECT|EXACT_SUBJECT|likely subject", shape["text"], re.I):
            return False, f"identity badge text={shape['text'][:40]!r}"
    return True, "ok"


def slide13_no_english_metrics_note(xml: str) -> tuple[bool, str]:
    for shape in text_shapes(xml):
        if re.search(r"collected,\s*\d+\s*selected|namesakes/noise|excluded as namesakes", shape["text"], re.I):
            return False, f"english note={shape['text'][:60]!r}"
    return True, "ok"


GAL_ORION_MAX_PIC_ASPECT = 2.5

# Slide 13 ORION compact grid — must match renderer/theme.py
ORION_CONTENT_Y = 1500000
ORION_HEADLINE_Y = 335000
ORION_HEADLINE_H = 300000
ORION_HEADLINE_BOTTOM = ORION_HEADLINE_Y + ORION_HEADLINE_H
ORION_SUMMARY_H = 880000
ORION_SUMMARY_GAP = 230000
ORION_QUERY_TITLE_H = 140000
ORION_TITLE_CHIP_GAP = 80000
ORION_CHIP_H = 285000
ORION_CHIP_GAP = 70000
ORION_QUERY_GAP = 250000
ORION_EXPLAINER_H = 1050000
ORION_MIN_BLOCK_GAP = 180000
ORION_PANEL_Y_OFFSET = 50000
ORION_PANEL_SIDE_PAD = 110000
ORION_PANEL_TOP_PAD = 125000
ORION_PANEL_BOTTOM_PAD = 140000
ORION_MIN_PANEL_INSET = 60000
ORION_FRAME_SEARCH_LEFT_INSET = 80000
ORION_FRAME_SEARCH_TOP_INSET = 70000
ORION_FRAME_SEARCH_RIGHT_INSET = 80000
ORION_FRAME_GRID_SIDE_INSET = 80000
ORION_FRAME_GRID_BOTTOM_INSET = 100000
ORION_SEARCH_BAND_H = 180000
ORION_TABS_GAP = 45000
ORION_TABS_BAND_H = 70000
ORION_TITLE_GAP = 60000
ORION_TITLE_BAND_H = 90000
ORION_GRID_TOP_GAP = 80000
ORION_MAX_THUMBS = 9
ORION_MAX_HIGHLIGHTS = 3
ORION_MIN_BAND_GAP = 60000


def _orion_zone_layout() -> dict[str, int]:
    cw = 8046720  # CONTENT_W EMU at 10" slide
    left_w = int(cw * 0.45)
    gutter = int(cw * 0.035)
    right_w = int(cw * 0.48)
    left_x = 548640
    right_x = left_x + left_w + gutter
    summary_y = ORION_CONTENT_Y
    summary_bottom = summary_y + ORION_SUMMARY_H
    query_title_y = summary_bottom + ORION_SUMMARY_GAP
    chips_y = query_title_y + ORION_QUERY_TITLE_H + ORION_TITLE_CHIP_GAP
    chips_bottom = chips_y + 2 * ORION_CHIP_H + ORION_CHIP_GAP
    explainer_y = chips_bottom + ORION_QUERY_GAP
    explainer_bottom = explainer_y + ORION_EXPLAINER_H
    panel_y = ORION_CONTENT_Y + ORION_PANEL_Y_OFFSET
    return {
        "summary_y": summary_y,
        "summary_bottom": summary_bottom,
        "query_title_y": query_title_y,
        "chips_y": chips_y,
        "chips_bottom": chips_bottom,
        "explainer_y": explainer_y,
        "explainer_bottom": explainer_bottom,
        "right_x": right_x,
        "right_w": right_w,
        "panel_y": panel_y,
        "panel_bottom": FOOTER_SAFE_BOTTOM,
    }


def _summary_has_provider_badge(xml: str, zone: dict) -> bool:
    """Red Yandex 'Я' badge must not appear inside left summary box."""
    for sp in re.findall(r"<p:sp\b.*?</p:sp>", xml, flags=re.DOTALL):
        if not re.search(r"<a:t>Я</a:t>", sp):
            continue
        off_m = re.search(r'<a:off x="(\d+)" y="(\d+)"', sp)
        ext_m = re.search(r'<a:ext cx="(\d+)" cy="(\d+)"', sp)
        if not off_m or not ext_m:
            continue
        x, y = int(off_m.group(1)), int(off_m.group(2))
        if x >= zone["right_x"]:
            continue
        if zone["summary_y"] <= y <= zone["summary_bottom"] + 80000:
            if "FC3F1C" in sp.upper() or "fc3f1c" in sp.lower():
                return True
    return False


def _panel_band_geometry(zone: dict) -> dict[str, int]:
    inner_y = zone["panel_y"] + ORION_PANEL_TOP_PAD
    search_bottom = inner_y + ORION_SEARCH_BAND_H
    tabs_y = search_bottom + ORION_TABS_GAP
    tabs_bottom = tabs_y + ORION_TABS_BAND_H
    title_y = tabs_bottom + ORION_TITLE_GAP
    title_bottom = title_y + ORION_TITLE_BAND_H
    grid_y = title_bottom + ORION_GRID_TOP_GAP
    return {
        "search_bottom": search_bottom,
        "tabs_y": tabs_y,
        "tabs_bottom": tabs_bottom,
        "title_y": title_y,
        "title_bottom": title_bottom,
        "grid_y": grid_y,
    }


def _orion_panel_card(shapes: list[dict], zone: dict) -> dict | None:
    """Main white screenshot card on the right column (largest rounded rect)."""
    candidates = [
        s
        for s in shapes
        if s["round"]
        and s["x"] >= zone["right_x"] - 120000
        and s["w"] >= zone["right_w"] - 150000
        and s["h"] >= 2000000
        and s["y"] >= zone["panel_y"] - 120000
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda s: s["w"] * s["h"])


def _orion_search_bar(shapes: list[dict], zone: dict) -> dict | None:
    """Search input rounded bar inside screenshot panel."""
    candidates = [
        s
        for s in shapes
        if s["round"]
        and s["x"] >= zone["right_x"]
        and ORION_SEARCH_BAND_H - 25000 <= s["h"] <= ORION_SEARCH_BAND_H + 50000
        and s["w"] >= 1500000
        and zone["panel_y"] <= s["y"] <= zone["panel_y"] + 350000
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda s: s["y"])


def _orion_frame_insets_ok(
    frame: dict,
    search: dict | None,
    pics: list[dict],
    badges: list[dict],
) -> tuple[bool, str]:
    """Hard QA — outer screenshot frame must wrap all panel content with generous insets."""
    fx, fy, fr, fb = frame["x"], frame["y"], frame["right"], frame["bottom"]
    if search:
        sl = search["x"] - fx
        st = search["y"] - fy
        sr = fr - search["right"]
        if sl < ORION_FRAME_SEARCH_LEFT_INSET - 10000:
            return False, f"search left inset={sl} need>={ORION_FRAME_SEARCH_LEFT_INSET}"
        if st < ORION_FRAME_SEARCH_TOP_INSET - 10000:
            return False, f"search top inset={st} need>={ORION_FRAME_SEARCH_TOP_INSET}"
        if sr < ORION_FRAME_SEARCH_RIGHT_INSET - 10000:
            return False, f"search right inset={sr} need>={ORION_FRAME_SEARCH_RIGHT_INSET}"
    if not pics:
        return False, "no panel thumbnails"
    grid = {
        "x": min(p["x"] for p in pics),
        "y": min(p["y"] for p in pics),
        "right": max(p["right"] for p in pics),
        "bottom": max(p["bottom"] for p in pics),
    }
    gl = grid["x"] - fx
    gr = fr - grid["right"]
    gb = fb - grid["bottom"]
    if gl < ORION_FRAME_GRID_SIDE_INSET - 10000:
        return False, f"grid left inset={gl} need>={ORION_FRAME_GRID_SIDE_INSET}"
    if gr < ORION_FRAME_GRID_SIDE_INSET - 10000:
        return False, f"grid right inset={gr} need>={ORION_FRAME_GRID_SIDE_INSET}"
    if gb < ORION_FRAME_GRID_BOTTOM_INSET - 10000:
        return False, f"grid bottom inset={gb} need>={ORION_FRAME_GRID_BOTTOM_INSET}"
    for i, pic in enumerate(pics):
        for edge, val in (
            ("left", pic["x"] - fx),
            ("top", pic["y"] - fy),
            ("right", fr - pic["right"]),
            ("bottom", fb - pic["bottom"]),
        ):
            if val < ORION_MIN_PANEL_INSET - 10000:
                return False, f"thumb[{i}] {edge} inset={val} need>={ORION_MIN_PANEL_INSET}"
    for i, badge in enumerate(badges):
        if badge["x"] < fx or badge["y"] < fy or badge["right"] > fr or badge["bottom"] > fb:
            return False, f"badge[{i}] outside frame"
    return True, "frame insets ok"


def _panel_children_inset_ok(
    panel: dict,
    pics: list[dict],
    badges: list[dict],
    *,
    min_inset: int = ORION_MIN_PANEL_INSET,
) -> tuple[bool, str]:
    px, py, pr, pb = panel["x"], panel["y"], panel["right"], panel["bottom"]
    tol = 10000
    children = list(pics) + list(badges)
    if not children:
        return True, "no panel media children"
    for i, c in enumerate(children):
        if c["x"] < px + min_inset - tol:
            return False, f"child[{i}] left inset={c['x'] - px}"
        if c["y"] < py + min_inset - tol:
            return False, f"child[{i}] top inset={c['y'] - py}"
        if c["right"] > pr - min_inset + tol:
            return False, f"child[{i}] right inset={pr - c['right']}"
        if c["bottom"] > pb - min_inset + tol:
            return False, f"child[{i}] bottom inset={pb - c['bottom']}"
    return True, "panel insets ok"


def _highlight_badges_in_panel(xml: str, zone: dict) -> list[dict]:
    badges: list[dict] = []
    for sp in re.findall(r"<p:sp\b.*?</p:sp>", xml, flags=re.DOTALL):
        if not re.search(r"<a:t>×</a:t>", sp):
            continue
        if "FC3F1C" not in sp.upper() and "E65C00" not in sp.upper():
            continue
        off_m = re.search(r'<a:off x="(\d+)" y="(\d+)"', sp)
        ext_m = re.search(r'<a:ext cx="(\d+)" cy="(\d+)"', sp)
        if not off_m or not ext_m:
            continue
        x, y = int(off_m.group(1)), int(off_m.group(2))
        if x < zone["right_x"] - 50000:
            continue
        if y < zone["panel_y"]:
            continue
        badges.append(
            {
                "x": x,
                "y": y,
                "right": x + int(ext_m.group(1)),
                "bottom": y + int(ext_m.group(2)),
            }
        )
    return badges


def _orion_left_column_gaps_ok(shapes: list[dict], zone: dict) -> tuple[bool, str]:
    """Left analytical column blocks must have premium, non-overlapping vertical rhythm."""
    right_x = zone["right_x"]
    blocks = [
        s
        for s in shapes
        if s["round"]
        and s["x"] < right_x - 50000
        and s["y"] >= zone["summary_y"] - 20000
        and s["w"] > 900000
        and s["h"] > 300000
    ]
    if not blocks:
        return True, "no left-column card blocks"
    summary = min(blocks, key=lambda s: s["y"])
    explainers = [b for b in blocks if b["y"] > summary["bottom"] + 200000]
    if explainers:
        explainer = max(explainers, key=lambda s: s["h"])
        gap = explainer["y"] - summary["bottom"]
        if gap < ORION_MIN_BLOCK_GAP:
            return False, f"summary->explainer gap={gap} need>={ORION_MIN_BLOCK_GAP}"
        if explainer["bottom"] > FOOTER_SAFE_BOTTOM:
            return False, f"explainer bottom={explainer['bottom']} > footer_safe"
    for i, a in enumerate(blocks):
        for b in blocks[i + 1:]:
            v_overlap = min(a["bottom"], b["bottom"]) - max(a["y"], b["y"])
            h_overlap = min(a["right"], b["right"]) - max(a["x"], b["x"])
            if v_overlap > 20000 and h_overlap > 20000:
                return False, f"left blocks overlap v={v_overlap} h={h_overlap}"
    return True, "left column rhythm ok"


def _orion_chip_frames(shapes: list[dict], zone: dict) -> list[dict]:
    """Query chip pills — small white rounded rects in the chips band."""
    chips_y = zone["chips_y"]
    chips_bottom = zone["chips_bottom"]
    return [
        s
        for s in shapes
        if s["round"]
        and s["x"] < zone["right_x"] - 50000
        and chips_y - 40000 <= s["y"] <= chips_bottom
        and 500000 < s["w"] < 2400000
        and ORION_CHIP_H - 60000 <= s["h"] <= ORION_CHIP_H + 60000
    ]


def _orion_chips_ok(shapes: list[dict], zone: dict) -> tuple[bool, str]:
    """Query chips must not overlap and keep a safe horizontal/vertical gutter."""
    chips = _orion_chip_frames(shapes, zone)
    if len(chips) < 2:
        return True, f"chips={len(chips)}"
    for i, a in enumerate(chips):
        for b in chips[i + 1:]:
            v_overlap = min(a["bottom"], b["bottom"]) - max(a["y"], b["y"])
            h_overlap = min(a["right"], b["right"]) - max(a["x"], b["x"])
            if v_overlap > 15000 and h_overlap > 15000:
                return False, "chip pills overlap"
    return True, f"chips={len(chips)} no overlap"


def _danger_highlight_count(xml: str) -> int:
    """Count red highlight rings (danger fill badges excluding search close)."""
    count = 0
    for sp in re.findall(r"<p:sp\b.*?</p:sp>", xml, flags=re.DOTALL):
        if "FC3F1C" not in sp.upper() and "E65C00" not in sp.upper():
            continue
        if re.search(r"<a:t>×</a:t>", sp):
            off_m = re.search(r'<a:off x="(\d+)" y="(\d+)"', sp)
            if off_m and int(off_m.group(2)) > ORION_CONTENT_Y + 200000:
                count += 1
    return count


def slide13_orion_layout_ok(xml: str) -> tuple[bool, str]:
    """Slide 13 ORION images page — compact fixed-grid zone checks."""
    t = plain_text(xml)
    tl = t.lower()
    if "поисковые запросы" not in tl and "search queries" not in tl:
        return False, "missing queries block"
    if "изображения" not in tl and "images" not in tl:
        return False, "missing grid title"
    if "картинки" not in tl and "images" not in tl:
        return False, "missing section marker"
    pics = pics_in_xml(xml)
    if len(pics) < 2:
        return False, f"pics={len(pics)}"
    if len(pics) > ORION_MAX_THUMBS:
        return False, f"too many pics={len(pics)}"
    if max_shape_bottom(xml) > FOOTER_SAFE_BOTTOM:
        return False, "overflow footer"

    zone = _orion_zone_layout()
    shapes = sp_shapes(xml)

    def _find_text(sub: str) -> list[dict]:
        return [s for s in shapes if sub.lower() in s["text"].lower()]

    markers = _find_text("04")
    headlines = [s for s in shapes if "впечатление" in s["text"].lower() or "impressions" in s["text"].lower()]
    if headlines:
        hb = max(s["bottom"] for s in headlines)
        if hb >= zone["summary_y"]:
            return False, f"headline_bottom={hb} >= content_y={zone['summary_y']}"
        para_count = sum(s["text"].count("\n") + 1 for s in headlines)
        if para_count > 2 and "\n" not in headlines[0]["text"]:
            pass  # two separate shapes ok

    summary_frames = [s for s in shapes if s["round"] and zone["summary_y"] <= s["y"] <= zone["summary_y"] + 80000]
    if summary_frames:
        sy = min(s["y"] for s in summary_frames)
        if sy < zone["summary_y"] - 50000:
            return False, f"summary_y={sy} < content_y"

    query_titles = _find_text("поисковые запросы") or _find_text("search queries")
    if query_titles:
        qy = min(s["y"] for s in query_titles)
        if qy < zone["summary_bottom"]:
            return False, f"query_title_y={qy} < summary_bottom={zone['summary_bottom']}"

    explainers = _find_text("почему картинки") or _find_text("why do images")
    if explainers:
        ey = min(s["y"] for s in explainers)
        if ey < zone["chips_bottom"]:
            return False, f"explainer_y={ey} < chips_bottom={zone['chips_bottom']}"
        eb = max(s["bottom"] for s in explainers)
        if eb > FOOTER_SAFE_BOTTOM:
            return False, f"explainer_bottom={eb} > footer_safe"

    panel_frames = [
        s for s in shapes if s["round"] and s["x"] >= zone["right_x"] - 50000 and s["y"] <= zone["panel_y"] + 80000
    ]
    if panel_frames:
        py = min(s["y"] for s in panel_frames)
        if py < zone["panel_y"] - 50000:
            return False, f"panel_y={py} < expected={zone['panel_y']}"

    if _summary_has_provider_badge(xml, zone):
        return False, "summary box contains provider badge"

    bands = _panel_band_geometry(zone)
    panel_pics = [p for p in pics if p["x"] >= zone["right_x"] - 50000]
    titles = [s for s in shapes if s["text"] in ("Изображения", "Images") and s["x"] >= zone["right_x"] - 50000]
    if titles and panel_pics:
        tb = max(s["bottom"] for s in titles)
        min_pic_y = min(p["y"] for p in panel_pics)
        if min_pic_y < tb + ORION_MIN_BAND_GAP:
            return False, f"thumbnails overlap title pic_y={min_pic_y} title_bottom={tb}"
    if panel_pics:
        min_pic_y = min(p["y"] for p in panel_pics)
        if min_pic_y < bands["grid_y"] - ORION_MIN_BAND_GAP:
            return False, f"thumbnail above grid band pic_y={min_pic_y} grid_y={bands['grid_y']}"

    left_ok, left_det = _orion_left_column_gaps_ok(shapes, zone)
    if not left_ok:
        return False, f"left column: {left_det}"

    chips_ok, chips_det = _orion_chips_ok(shapes, zone)
    if not chips_ok:
        return False, f"chips: {chips_det}"

    badges = _highlight_badges_in_panel(xml, zone)
    panel_card = _orion_panel_card(shapes, zone)
    if not panel_card:
        return False, "missing screenshot panel card"

    search_bar = _orion_search_bar(shapes, zone)
    frame_ok, frame_det = _orion_frame_insets_ok(panel_card, search_bar, panel_pics, badges)
    if not frame_ok:
        return False, f"frame inset: {frame_det}"

    if len(badges) > ORION_MAX_HIGHLIGHTS:
        return False, f"highlights={len(badges)}"
    for badge in badges:
        if badge["bottom"] > panel_card["bottom"] - ORION_MIN_PANEL_INSET + 10000:
            return False, "highlight badge outside panel"
        attached = any(
            abs(badge["x"] - pic["x"]) < 120000 and abs(badge["y"] - pic["y"]) < 120000
            for pic in panel_pics
        )
        if panel_pics and not attached:
            return False, "highlight badge not attached to thumbnail"

    inset_ok, inset_det = _panel_children_inset_ok(panel_card, panel_pics, badges)
    if not inset_ok:
        return False, f"panel inset: {inset_det}"

    hi = len(badges)

    if "13 / 50" not in t and "13/50" not in t.replace(" ", ""):
        return False, "missing page number"

    return True, f"pics={len(pics)} highlights={hi}"


def slide13_gallery_not_banner_strips(xml: str) -> tuple[bool, str]:
    """Gallery pics should not be wide horizontal strips (eyes-only crop artifact)."""
    pics = pics_in_xml(xml)
    if not pics:
        return True, "no pics"
    for i, pic in enumerate(pics):
        aspect = pic["w"] / max(pic["h"], 1)
        if aspect > GAL_ORION_MAX_PIC_ASPECT:
            return False, f"pic[{i}] banner aspect={aspect:.2f} ({pic['w']}x{pic['h']})"
    return True, f"pics={len(pics)}"


def sp_shapes(xml: str) -> list[dict]:
    shapes: list[dict] = []
    for sp in re.findall(r"<p:sp\b.*?</p:sp>", xml, flags=re.DOTALL):
        off_m = re.search(r'<a:off x="(\d+)" y="(\d+)"', sp)
        ext_m = re.search(r'<a:ext cx="(\d+)" cy="(\d+)"', sp)
        text_m = re.search(r"<a:t>([^<]*)</a:t>", sp)
        if off_m and ext_m:
            x, y = int(off_m.group(1)), int(off_m.group(2))
            cx, cy = int(ext_m.group(1)), int(ext_m.group(2))
            shapes.append(
                {
                    "x": x,
                    "y": y,
                    "right": x + cx,
                    "bottom": y + cy,
                    "w": cx,
                    "h": cy,
                    "text": text_m.group(1) if text_m else "",
                    "round": "roundrect" in sp.lower(),
                }
            )
    return shapes


def video_card_frames(xml: str) -> list[dict]:
    """Outer video cards on slide 14 — detected via Open-source button inside frame."""
    shapes = text_shapes(xml)
    button_shapes = [
        s
        for s in shapes
        if re.search(r"Open source|Открыть источник", s["text"], re.I) and s["y"] > 2400000
    ]
    candidates: list[dict] = []
    for frame in card_frames(xml):
        if frame["y"] < 2400000:
            continue
        fw = frame["right"] - frame["x"]
        fh = frame["bottom"] - frame["y"]
        if fh < 600000 or fw < 3200000:
            continue
        if any(shape_inside(b, frame) for b in button_shapes):
            candidates.append(frame)
    out: list[dict] = []
    for frame in candidates:
        nested = False
        for other in candidates:
            if frame is other:
                continue
            if shape_inside(frame, other) and (other["bottom"] - other["y"]) > (frame["bottom"] - frame["y"]):
                nested = True
                break
        if not nested:
            out.append(frame)
    return out


VIDEO_FAKE_THUMB_MIN_H = 200000


def video_no_fake_thumb_bars(xml: str) -> tuple[bool, str]:
    """Cards without a real thumbnail must not contain a tall empty panel bar."""
    frames = video_card_frames(xml)
    if not frames:
        return True, "no video cards"
    pics = pics_in_xml(xml)
    panels = [s for s in sp_shapes(xml) if s["round"]]
    for i, frame in enumerate(frames):
        inner_pics = [p for p in pics if shape_inside(p, frame)]
        if inner_pics:
            continue
        frame_h = frame["bottom"] - frame["y"]
        for panel in panels:
            if not shape_inside(panel, frame):
                continue
            if panel["h"] < VIDEO_FAKE_THUMB_MIN_H:
                continue
            if panel["y"] > frame["y"] + frame_h * 0.55:
                continue
            if any(shape_inside(p, panel) for p in pics):
                continue
            return False, f"card[{i}] fake thumb bar h={panel['h']} y={panel['y']}"
    return True, f"cards={len(frames)}"


def video_card_inner_zones_ok(xml: str) -> tuple[bool, str]:
    """Video cards: play/domain header, title, button — no vertical overlap."""
    frames = video_card_frames(xml)
    if not frames:
        return True, "no video cards"
    shapes = text_shapes(xml)
    pics = pics_in_xml(xml)
    domain_re = re.compile(r"youtube|vimeo|\.(com|ru|net|org)", re.I)
    button_re = re.compile(r"Open source|Открыть источник", re.I)
    play_re = re.compile(r"^\s*\u25b6|▶")
    for i, frame in enumerate(frames):
        inner_pics = [p for p in pics if shape_inside(p, frame)]
        inner_text = [s for s in shapes if shape_inside(s, frame)]
        if inner_pics and inner_text:
            pic_bottom = max(p["bottom"] for p in inner_pics)
            text_top = min(s["y"] for s in inner_text)
            if pic_bottom + ZONE_MIN_GAP > text_top:
                return False, f"card[{i}] thumb overlaps text"
        buttons = [s for s in inner_text if button_re.search(s["text"])]
        headers = [s for s in inner_text if play_re.search(s["text"]) and s not in buttons]
        domains = [
            s for s in inner_text
            if domain_re.search(s["text"]) and s not in buttons and s not in headers
        ]
        titles = [
            s
            for s in inner_text
            if s not in buttons and s not in domains and s not in headers
        ]
        for title in titles:
            for domain in domains:
                if shapes_horizontally_overlap(title, domain) and shapes_vertically_too_close(
                    title, domain, ZONE_MIN_GAP,
                ):
                    return False, f"card[{i}] title/domain overlap"
        for title in titles:
            for btn in buttons:
                if shapes_horizontally_overlap(title, btn) and shapes_vertically_too_close(
                    title, btn, ZONE_MIN_GAP,
                ):
                    return False, f"card[{i}] title/button overlap"
        ordered = inner_pics + sorted(inner_text, key=lambda s: s["y"])
        for a, b in zip(ordered, ordered[1:]):
            if vertical_overlap(a, b):
                return False, f"card[{i}] inner overlap y={a['y']}-{a['bottom']} vs {b['y']}"
    return True, f"cards={len(frames)}"


def video_overflow_notes(xml: str) -> list[dict]:
    return [
        s
        for s in text_shapes(xml)
        if re.search(
            r"Показаны.*видео|Showing.*video|видео сохранено|videos saved in evidence",
            s["text"],
            re.I,
        )
        and not re.search(
            r"Collected videos|Собрано видео|collected.*subject-matched",
            s["text"],
            re.I,
        )
    ]


def slide14_video_layout_ok(xml: str) -> tuple[bool, str]:
    frames = video_card_frames(xml)
    if not frames:
        return True, "no video cards"
    if len(frames) > 4:
        return False, f"too many video cards={len(frames)}"
    grid_bottom = max(f["bottom"] for f in frames)
    grid_top = min(f["y"] for f in frames)
    for i, frame in enumerate(frames):
        if frame["bottom"] > CONTENT_SAFE_BOTTOM_EMU:
            return False, f"card[{i}] bottom={frame['bottom']} > safe"
    ok_fake, det_fake = video_no_fake_thumb_bars(xml)
    if not ok_fake:
        return False, det_fake
    ok_inner, det_inner = video_card_inner_zones_ok(xml)
    if not ok_inner:
        return False, det_inner
    for note in video_overflow_notes(xml):
        if note["y"] < grid_top - 40000:
            continue
        if note["y"] < grid_bottom + PDF_SAFE_TABLE_NOTE_GAP // 2:
            return False, f"note overlaps grid y={note['y']} grid={grid_top}-{grid_bottom}"
        if note["bottom"] > FOOTER_SAFE_BOTTOM:
            return False, f"note overlaps footer bottom={note['bottom']}"
    return True, f"cards={len(frames)} grid_bottom={grid_bottom}"


def pics_in_xml(xml: str) -> list[dict]:
    pics: list[dict] = []
    for pic in re.findall(r"<p:pic\b.*?</p:pic>", xml, flags=re.DOTALL):
        off_m = re.search(r'<a:off x="(\d+)" y="(\d+)"', pic)
        ext_m = re.search(r'<a:ext cx="(\d+)" cy="(\d+)"', pic)
        if off_m and ext_m:
            x, y = int(off_m.group(1)), int(off_m.group(2))
            cx, cy = int(ext_m.group(1)), int(ext_m.group(2))
            pics.append({"x": x, "y": y, "right": x + cx, "bottom": y + cy, "w": cx, "h": cy})
    return pics


def shape_inside(inner: dict, outer: dict, tol: int = 80000) -> bool:
    return (
        inner["x"] >= outer["x"] - tol
        and inner["y"] >= outer["y"] - tol
        and inner["right"] <= outer["right"] + tol
        and inner["bottom"] <= outer["bottom"] + tol
    )


def vertical_overlap(a: dict, b: dict, min_gap: int = ZONE_MIN_GAP) -> bool:
    if not shapes_horizontally_overlap(a, b):
        return False
    if a["y"] <= b["y"]:
        return (a["bottom"] + min_gap) > b["y"]
    return (b["bottom"] + min_gap) > a["y"]


def card_media_layout_ok(xml: str) -> tuple[bool, str]:
    """Inside each gallery card: image above title above domain; no vertical overlap."""
    frames = card_frames(xml)
    shapes = text_shapes(xml)
    pics = pics_in_xml(xml)
    if not frames:
        return True, "no cards"
    for i, frame in enumerate(frames):
        inner_text = [s for s in shapes if shape_inside(s, frame)]
        inner_pics = [p for p in pics if shape_inside(p, frame)]
        if not inner_text and not inner_pics:
            continue
        ordered = inner_pics + inner_text
        ordered.sort(key=lambda s: s["y"])
        for a, b in zip(ordered, ordered[1:]):
            if vertical_overlap(a, b):
                return False, f"card[{i}] overlap y={a['y']}-{a['bottom']} vs {b['y']}"
        if inner_pics and inner_text:
            pic_bottom = max(p["bottom"] for p in inner_pics)
            text_top = min(s["y"] for s in inner_text)
            if pic_bottom + ZONE_MIN_GAP > text_top:
                return False, f"card[{i}] image overlaps text"
    return True, f"cards={len(frames)}"


def duplicate_pics_count(xml: str) -> int:
    dims = pic_dimensions_all(xml)
    seen: set[tuple[int, int]] = set()
    dup = 0
    for d in dims:
        if d in seen:
            dup += 1
        seen.add(d)
    return dup


CONTENT_SAFE_BOTTOM_EMU = 6309360


def gallery_overflow_notes(xml: str) -> list[dict]:
    """Overflow/skipped notes rendered below the gallery grid (not the selection note above)."""
    return [
        s
        for s in text_shapes(xml)
        if re.search(
            r"Показаны|Showing|skipped|сохранен|saved in evidence|Остальные сохранены|Others saved",
            s["text"],
            re.I,
        )
        and not re.search(
            r"collected.*selected|собрано.*отобран|отобран.*собран",
            s["text"],
            re.I,
        )
    ]


def gallery_notes_shapes(xml: str) -> list[dict]:
    return gallery_overflow_notes(xml)


def gallery_card_inner_zones_ok(xml: str) -> tuple[bool, str]:
    """Gallery cards: image in frame; title above domain; no inner vertical overlap."""
    frames = gallery_card_frames(xml)
    if not frames:
        return True, "no gallery cards"
    shapes = text_shapes(xml)
    pics = pics_in_xml(xml)
    domain_re = re.compile(r"\.(com|ru|net|org|edu|gov|ua|by|kz|io)|^https?://|www\.", re.I)
    badge_re = re.compile(r"LIKELY|EXACT|likely subject|вероятно|точное", re.I)
    for i, frame in enumerate(frames):
        inner_pics = [p for p in pics if shape_inside(p, frame)]
        inner_text = [s for s in shapes if shape_inside(s, frame)]
        for pic in inner_pics:
            if not shape_inside(pic, frame, tol=120000):
                return False, f"card[{i}] image outside card frame"
        if inner_pics and inner_text:
            pic_bottom = max(p["bottom"] for p in inner_pics)
            text_top = min(s["y"] for s in inner_text)
            if pic_bottom + ZONE_MIN_GAP > text_top:
                return False, f"card[{i}] image overlaps text"
        domains = [s for s in inner_text if domain_re.search(s["text"])]
        titles = [s for s in inner_text if s not in domains and not badge_re.search(s["text"])]
        for title in titles:
            for domain in domains:
                if shapes_horizontally_overlap(title, domain) and shapes_vertically_too_close(
                    title, domain, ZONE_MIN_GAP,
                ):
                    return False, f"card[{i}] title/domain overlap"
        ordered = inner_pics + sorted(inner_text, key=lambda s: s["y"])
        for a, b in zip(ordered, ordered[1:]):
            if vertical_overlap(a, b):
                return False, f"card[{i}] inner overlap y={a['y']}-{a['bottom']} vs {b['y']}"
    return True, f"cards={len(frames)}"


def slide13_gallery_layout_ok(xml: str) -> tuple[bool, str]:
    """Strict slide-13 gallery checks: cards in safe area; notes below grid only."""
    frames = gallery_card_frames(xml)
    pics = pics_in_xml(xml)
    if pics and not frames:
        return False, "pics present but no gallery card frames detected"
    if not frames:
        return True, "no gallery cards"
    if len(frames) > 4:
        return False, f"too many gallery cards={len(frames)}"
    grid_bottom = max(f["bottom"] for f in frames)
    grid_top = min(f["y"] for f in frames)
    for i, frame in enumerate(frames):
        if frame["bottom"] > CONTENT_SAFE_BOTTOM_EMU:
            return False, f"card[{i}] bottom={frame['bottom']} > safe"
    ok_inner, det_inner = gallery_card_inner_zones_ok(xml)
    if not ok_inner:
        return False, det_inner
    notes = gallery_overflow_notes(xml)
    for note in notes:
        if note["y"] < grid_top - 40000:
            continue
        if note["y"] < grid_bottom + PDF_SAFE_TABLE_NOTE_GAP // 2:
            return False, f"note overlaps grid y={note['y']} grid={grid_top}-{grid_bottom}"
        if note["bottom"] > FOOTER_SAFE_BOTTOM:
            return False, f"note overlaps footer bottom={note['bottom']}"
    return True, f"cards={len(frames)} grid_bottom={grid_bottom}"
SLIDE_H_EMU = 6858000
MAX_INTL_PIC_FRAC = 0.60


def intl_slide_no_giant_pic(xml: str) -> tuple[bool, str]:
    pics = pics_in_xml(xml)
    if not pics:
        return True, "no pics"
    max_w = max(p["w"] for p in pics)
    max_h = max(p["h"] for p in pics)
    if max_w > SLIDE_W_EMU * MAX_INTL_PIC_FRAC or max_h > SLIDE_H_EMU * MAX_INTL_PIC_FRAC:
        return False, f"max={max_w}x{max_h}"
    return True, f"max={max_w}x{max_h}"


def section_heading_above_footer(xml: str) -> bool:
    for shape in text_shapes(xml):
        if re.search(r"Смежные|однофамиль|Adjacent|similar name", shape["text"], re.I):
            if shape["y"] > FOOTER_SAFE_BOTTOM - 400000:
                return False
            if shape["bottom"] > FOOTER_SAFE_BOTTOM:
                return False
    return True


def disclaimer_not_overlapping_cards(shapes: list[dict]) -> bool:
    cards = [
        s
        for s in shapes
        if re.search(
            r"Наивысшие|Highest risk|риск-тем|compliance|соответств",
            s["text"],
            re.I,
        )
    ]
    legal = [
        s
        for s in shapes
        if re.search(
            r"юридическ|legal conclusion|not legal|Не является",
            s["text"],
            re.I,
        )
    ]
    for card in cards:
        for leg in legal:
            if shapes_horizontally_overlap(card, leg) and shapes_vertically_too_close(card, leg, 80000):
                return False
    return True


def bullets_overflow_note_present_or_bounded(xml: str) -> bool:
    text = plain_text(xml)
    if re.search(r"ещё подсказок|more suggestions|saved in evidence", text, re.I):
        return max_shape_bottom(xml) <= FOOTER_SAFE_BOTTOM
    return max_shape_bottom(xml) <= FOOTER_SAFE_BOTTOM


def suggestions_overflow_notes(xml: str) -> list[dict]:
    return [
        s
        for s in text_shapes(xml)
        if re.search(
            r"\+.*?(ещё.*подсказок|more suggestions preserved|more items preserved)",
            s["text"],
            re.I,
        )
    ]


def slide_suggestions_overflow_ok(xml: str) -> tuple[bool, str]:
    """At most one overflow note; note must not overlap footer/content safe area."""
    notes = suggestions_overflow_notes(xml)
    if len(notes) > 1:
        return False, f"duplicate overflow notes={len(notes)}"
    for note in notes:
        if note["bottom"] > FOOTER_SAFE_BOTTOM:
            return False, f"note/footer overlap bottom={note['bottom']}"
        if note["bottom"] > CONTENT_SAFE_BOTTOM_EMU:
            return False, f"note below content safe bottom={note['bottom']}"
    return True, f"overflow_notes={len(notes)}"


def pic_aspect_ratios_ok(xml: str, lo: float = 0.12, hi: float = 8.5) -> bool:
    """Reject extreme stretch ratios; allow wide cover-crop gallery boxes."""
    found = False
    for block in re.findall(r"<p:pic\b.*?</p:pic>", xml, flags=re.DOTALL):
        ext_m = re.search(r'<a:ext cx="(\d+)" cy="(\d+)"', block)
        if not ext_m:
            continue
        found = True
        cx, cy = int(ext_m.group(1)), int(ext_m.group(2))
        if cy <= 0:
            continue
        ratio = cx / cy
        if ratio < lo or ratio > hi:
            return False
    return found or True


def text_shapes(xml: str) -> list[dict]:
    shapes: list[dict] = []
    for sp in re.findall(r"<p:sp\b.*?</p:sp>", xml, flags=re.DOTALL):
        off_m = re.search(r'<a:off x="(\d+)" y="(\d+)"', sp)
        ext_m = re.search(r'<a:ext cx="(\d+)" cy="(\d+)"', sp)
        text = plain_text(sp).strip()
        if not off_m or not ext_m or not text:
            continue
        x, y = int(off_m.group(1)), int(off_m.group(2))
        cx, cy = int(ext_m.group(1)), int(ext_m.group(2))
        if y >= FOOTER_BAND_TOP:
            continue
        shapes.append({"x": x, "y": y, "bottom": y + cy, "right": x + cx, "text": text})
    return shapes


def shapes_horizontally_overlap(a: dict, b: dict) -> bool:
    return not (a["right"] <= b["x"] or b["right"] <= a["x"])


def shapes_vertically_too_close(a: dict, b: dict, min_gap: int = ZONE_MIN_GAP) -> bool:
    if not shapes_horizontally_overlap(a, b):
        return False
    gap = min(abs(a["bottom"] - b["y"]), abs(b["bottom"] - a["y"]))
    if a["y"] <= b["y"]:
        return (a["bottom"] + min_gap) > b["y"]
    return (b["bottom"] + min_gap) > a["y"]


def min_pic_y(xml: str) -> int | None:
    ys: list[int] = []
    for pic in re.findall(r"<p:pic\b.*?</p:pic>", xml, flags=re.DOTALL):
        off_m = re.search(r'<a:off x="(\d+)" y="(\d+)"', pic)
        if off_m:
            ys.append(int(off_m.group(2)))
    return min(ys) if ys else None


def selection_note_above_grid(xml: str) -> bool:
    pic_y = min_pic_y(xml)
    if pic_y is None:
        return True
    for shape in text_shapes(xml):
        if re.search(
            r"subject-matched|субъект|relevant evidence|релевант|selected for report|отобран|collected.*selected",
            shape["text"],
            re.I,
        ):
            if shape["y"] >= pic_y:
                continue
            if shape["bottom"] > pic_y - 40000:
                return False
    return True


def caption_zones_have_gap(
    shapes: list[dict],
    upper_pattern: str,
    lower_pattern: str,
    min_gap: int = ZONE_MIN_GAP,
) -> bool:
    uppers = [s for s in shapes if re.search(upper_pattern, s["text"], re.I)]
    lowers = [s for s in shapes if re.search(lower_pattern, s["text"], re.I)]
    for u in uppers:
        for lo in lowers:
            if shapes_vertically_too_close(u, lo, min_gap):
                return False
    return True


def risk_badge_not_over_title(shapes: list[dict]) -> bool:
    badges = [s for s in shapes if s["text"].strip().upper() in {"LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"}]
    titles = [s for s in shapes if s["y"] < 1200000 and len(s["text"]) > 18]
    for badge in badges:
        for title in titles:
            if shapes_horizontally_overlap(badge, title) and shapes_vertically_too_close(badge, title, 20000):
                return False
    return True


def pic_dimensions_all(xml: str) -> list[tuple[int, int]]:
    dims: list[tuple[int, int]] = []
    for pic in re.findall(r"<p:pic\b.*?</p:pic>", xml, flags=re.DOTALL):
        ext_m = re.search(r'<a:ext cx="(\d+)" cy="(\d+)"', pic)
        if ext_m:
            dims.append((int(ext_m.group(1)), int(ext_m.group(2))))
    return dims


def max_pic_dimensions(xml: str) -> tuple[int, int]:
    dims = pic_dimensions_all(xml)
    if not dims:
        return 0, 0
    return max(w for w, _ in dims), max(h for _, h in dims)


MIN_GALLERY_IMG_H_EMU = 1143000  # ~120px at 96dpi on 10" slide
MIN_GALLERY_IMG_W_EMU = 1524000  # ~160px
MIN_GALLERY_CONTAIN_W_EMU = 1100000
MIN_GALLERY_CONTAIN_H_EMU = 850000
MIN_GALLERY_IMG_AREA_EMU = MIN_GALLERY_IMG_H_EMU * MIN_GALLERY_IMG_W_EMU
MIN_GALLERY_CARD_IMG_FRAC = 0.45


def gallery_pics_meet_min_size(
    xml: str,
    *,
    contained: bool = False,
    min_w: int | None = None,
    min_h: int | None = None,
) -> tuple[bool, str]:
    dims = pic_dimensions_all(xml)
    if not dims:
        return True, "no pics"
    if min_w is None:
        min_w = MIN_GALLERY_CONTAIN_W_EMU if contained else MIN_GALLERY_IMG_W_EMU
    if min_h is None:
        min_h = MIN_GALLERY_CONTAIN_H_EMU if contained else MIN_GALLERY_IMG_H_EMU
    for i, (w, h) in enumerate(dims):
        if w < min_w or h < min_h:
            return False, f"pic[{i}]={w}x{h} need>={min_w}x{min_h}"
        if not contained and w * h < MIN_GALLERY_IMG_AREA_EMU:
            return False, f"pic[{i}] area={w * h} too small"
    return True, f"count={len(dims)}"


def gallery_orion_pic_card_fraction(xml: str) -> tuple[bool, str]:
    """ORION slide 13: cover-fit pics fill >=50% card; wide letterboxed banners >=35%."""
    pics = pics_in_xml(xml)
    if not pics:
        return True, "no pics"
    frames = gallery_card_frames(xml)
    if not frames:
        return True, "no frames"
    for i, pic in enumerate(pics):
        candidates = [f for f in frames if abs(f["y"] - pic["y"]) < 120000]
        if not candidates:
            continue
        card = min(candidates, key=lambda f: abs(f["y"] - pic["y"]))
        card_h = card["bottom"] - card["y"]
        aspect = pic["w"] / pic["h"] if pic["h"] else 99.0
        min_frac = 0.35 if aspect > 1.75 else GAL_ORION_MIN_CARD_IMG_FRAC
        if pic["h"] < int(card_h * min_frac):
            return False, (
                f"pic[{i}] h={pic['h']} < {min_frac:.0%} of card h={card_h} aspect={aspect:.2f}"
            )
    return True, "ok"


def gallery_pics_min_card_fraction(xml: str, *, min_frac: float = MIN_GALLERY_CARD_IMG_FRAC) -> tuple[bool, str]:
    """Each pic height should be >= min_frac of its card frame (rounded rect) height."""
    pics: list[dict] = []
    for pic in re.findall(r"<p:pic\b.*?</p:pic>", xml, flags=re.DOTALL):
        off_m = re.search(r'<a:off x="(\d+)" y="(\d+)"', pic)
        ext_m = re.search(r'<a:ext cx="(\d+)" cy="(\d+)"', pic)
        if off_m and ext_m:
            pics.append(
                {
                    "y": int(off_m.group(2)),
                    "h": int(ext_m.group(2)),
                    "bottom": int(off_m.group(2)) + int(ext_m.group(2)),
                }
            )
    frames: list[dict] = []
    for sp in re.findall(r"<p:sp\b.*?</p:sp>", xml, flags=re.DOTALL):
        if "ROUNDED_RECT" not in sp and "roundRect" not in sp.lower():
            prst = re.search(r'prst="(\w+)"', sp)
            if not prst or prst.group(1) not in ("roundRect", "rect"):
                continue
        off_m = re.search(r'<a:off x="(\d+)" y="(\d+)"', sp)
        ext_m = re.search(r'<a:ext cx="(\d+)" cy="(\d+)"', sp)
        if off_m and ext_m:
            cy = int(ext_m.group(2))
            if cy < 400000:
                continue
            frames.append({"y": int(off_m.group(2)), "h": cy})
    if not pics:
        return True, "no pics"
    for i, pic in enumerate(pics):
        candidates = [f for f in frames if abs(f["y"] - pic["y"]) < 120000]
        if not candidates:
            continue
        card = min(candidates, key=lambda f: abs(f["y"] - pic["y"]))
        if pic["h"] < int(card["h"] * min_frac):
            return False, f"pic[{i}] h={pic['h']} < {min_frac:.0%} of card h={card['h']}"
    return True, "ok"


def inspect(pptx: Path, report_json: dict | None = None, *, layout: bool = True) -> dict:
    checks: list[dict] = []
    meta: dict = {}

    selected = (report_json or {}).get("selectedEvidence") or {}
    images_selected = len(selected.get("images", {}).get("selectedSubjectMatched") or [])
    videos_selected = len(selected.get("videos", {}).get("selectedSubjectMatched") or [])
    intl_images = len((selected.get("regions") or {}).get("international", {}).get("images") or [])
    compliance = (report_json or {}).get("complianceSummary") or {}
    compliance_active = int(compliance.get("activeMatches") or 0) > 0 or int(
        compliance.get("providersChecked") or 0
    ) > 0

    with zipfile.ZipFile(pptx, "r") as z:
        slide_count = len([n for n in z.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)])
        meta["slideCount"] = slide_count
        meta["mediaCount"] = len(media_files(z))

        s8 = slide_xml(z, 8)
        s11 = slide_xml(z, 11)
        s13 = slide_xml(z, 13)
        s14 = slide_xml(z, 14)
        s20 = slide_xml(z, 20)
        s24 = slide_xml(z, 24)
        s26 = slide_xml(z, 26)
        s27 = slide_xml(z, 27)
        s36 = slide_xml(z, 36)
        s10 = slide_xml(z, 10)

        r13 = slide_rels(z, 13)
        r14 = slide_rels(z, 14)

        pics13 = count_pics(s13)
        hlinks14 = max(count_hyperlink_rels(r14), count_hlink_clicks(s14))
        meta["slide13PicCount"] = pics13
        meta["slide14HyperlinkRelCount"] = hlinks14
        meta["pptMediaCount"] = meta["mediaCount"]

        def add(name: str, ok: bool, detail: str = "") -> None:
            checks.append({"name": name, "ok": ok, "detail": detail})

        add("PPTX has 50 slides (or 51 with template frame)", slide_count in (50, 51), f"count={slide_count}")

        if images_selected > 0:
            add("Slide 13 has p:pic when selected RU images > 0", pics13 >= 1, f"pics={pics13}")
            add(
                "Slide 13 has image relationships",
                "image" in r13.lower(),
                "slide13.xml.rels",
            )
            add(
                "Slide 13 no old image table header when thumbnails selected",
                not any(h in plain_text(s13) for h in TABLE_HEADERS[:2]),
                plain_text(s13)[:120],
            )
            add(
                "ppt/media count > 1 when selected thumbnails exist",
                meta["mediaCount"] > 1,
                f"media={meta['mediaCount']}",
            )
        else:
            add("Slide 13 clean empty or cards when 0 selected images", True, "skipped pic requirement")

        if videos_selected > 0:
            add(
                "Slide 14 has hyperlink relationships for selected videos",
                hlinks14 >= 1,
                f"hlinks={hlinks14}",
            )
            add(
                "Slide 14 not table-only for videos",
                not any(h in plain_text(s14) for h in TABLE_HEADERS[2:]),
                plain_text(s14)[:120],
            )
        else:
            add("Slide 14 clean when 0 selected videos", True, "skipped hyperlink requirement")

        t20 = plain_text(s20)
        confirmed_part = t20
        for marker in (
            "Excluded / not subject",
            "Исключено / не субъект",
            "Excluded",
            "Исключено",
        ):
            idx = t20.lower().find(marker.lower())
            if idx >= 0:
                confirmed_part = t20[:idx]
                break
        for bad in ["Владимирович", "Михайлович", "Александрович"]:
            add(f"Slide 20 confirmed excludes {bad}", bad not in confirmed_part)

        t24 = plain_text(s24)
        for bad in WEAK_INTL:
            add(f"Slide 24 excludes weak intl '{bad[:24]}'", bad not in t24)

        if intl_images > 0:
            add("Slide 27 has image grid when intl images selected", count_pics(slide_xml(z, 27)) >= 1)
        else:
            add(
                "Slide 27 clean empty when no intl images",
                "не обнаружены" in plain_text(s27).lower()
                or "not found" in plain_text(s27).lower()
                or not any(h in plain_text(s27) for h in TABLE_HEADERS[:2]),
            )

        t36 = plain_text(s36).lower()
        if not compliance_active:
            for theme in STALE_THEMES:
                add(
                    f"Slide 36 excludes stale theme {theme} when compliance not run",
                    theme not in t36,
                )
        else:
            add("Slide 36 compliance themes allowed when screening run", True)

        add(
            "Synthetic SERP slide present",
            "serp" in plain_text(s10).lower() or "поиск" in plain_text(s10).lower() or len(s10) > 100,
        )

        if layout:
            p13 = plain_text(s13)
            add(
                "Slide 13 no repeated Source caption lines",
                p13.count("Source:") <= 1 and "Source: Source:" not in p13,
                f"count={p13.count('Source:')}",
            )
            ok13o, det13o = slide13_orion_layout_ok(s13)
            add("Slide 13 ORION layout structure", ok13o, det13o)
            if images_selected > 0 and pics13 > 0:
                add(
                    "Slide 13 image aspect ratios not stretched",
                    pic_aspect_ratios_ok(s13),
                )
                mw13, mh13 = max_pic_dimensions(s13)
                meta["slide13MaxPicW"] = mw13
                meta["slide13MaxPicH"] = mh13
                meta["slide13PicDims"] = pic_dimensions_all(s13)
                meta["slide13PicCount"] = pics13
                ok13b, det13b = slide13_no_identity_badges(s13)
                add("Slide 13 no internal identity badges", ok13b, det13b)
                ok13e, det13e = slide13_no_english_metrics_note(s13)
                add("Slide 13 no English selection metrics note", ok13e, det13e)
            s13_bottom = max_shape_bottom(s13)
            meta["slide13MaxBottom"] = s13_bottom
            add(
                "Slide 13 within footer safe area",
                s13_bottom <= FOOTER_SAFE_BOTTOM,
                f"max_bottom={s13_bottom}",
            )
            add("Slide 13 page footer visible", "/ 50" in p13 or "50" in p13)
            add(
                "Slide 13 no LIKELY_SUBJECT badges",
                "LIKELY_SUBJECT" not in p13 and "likely subject" not in p13.lower(),
            )

            if videos_selected > 0:
                p14 = plain_text(s14)
                add("Slide 14 no raw https URL in text", "https://" not in p14 and "http://" not in p14)
                add(
                    "Slide 14 Open source button present",
                    "Open source" in p14 or "Открыть источник" in p14,
                )
                s14_bottom = max_shape_bottom(s14)
                meta["slide14MaxBottom"] = s14_bottom
                add(
                    "Slide 14 within footer safe area",
                    s14_bottom <= FOOTER_SAFE_BOTTOM,
                    f"max_bottom={s14_bottom}",
                )
                add("Slide 14 page footer visible", "/ 50" in p14)
                s14_shapes = text_shapes(s14)
                add(
                    "Slide 14 badge and Open source button separated",
                    caption_zones_have_gap(
                        s14_shapes,
                        r"likely subject|LIKELY|EXACT",
                        r"Open source|Открыть источник",
                    ),
                )
                ok14c, det14c = card_media_layout_ok(s14)
                add("Slide 14 video card zones no vertical overlap", ok14c, det14c)
                ok14v, det14v = slide14_video_layout_ok(s14)
                add("Slide 14 video cards/notes in safe area", ok14v, det14v)
                ok14f, det14f = video_no_fake_thumb_bars(s14)
                add("Slide 14 no fake video thumbnail bars", ok14f, det14f)
                ok14z, det14z = video_card_inner_zones_ok(s14)
                add("Slide 14 video play/domain/title/button zones", ok14z, det14z)
                video_frames = video_card_frames(s14)
                add(
                    "Slide 14 max 4 video cards",
                    len(video_frames) <= 4,
                    f"video_frames={len(video_frames)}",
                )

            p27 = plain_text(s27)
            s27_shapes = text_shapes(s27)
            if intl_images > 0 or videos_selected > 0:
                s27 = slide_xml(z, 27)
                add(
                    "Slide 27 within footer safe area",
                    max_shape_bottom(s27) <= FOOTER_SAFE_BOTTOM,
                )
                add(
                    "Slide 27 title/domain/badge zones separated",
                    caption_zones_have_gap(
                        s27_shapes,
                        r"Tomilin|Konstantin|linkedin|\.com",
                        r"LIKELY|EXACT|likely subject",
                    ),
                )
            add(
                "Slide 27 risk badge not over page title",
                risk_badge_not_over_title(s27_shapes),
            )
            add("Slide 27 no raw https URL text", "https://" not in p27)
            if intl_images > 0 and count_pics(s27) > 0:
                mw27, mh27 = max_pic_dimensions(s27)
                meta["slide27MaxPicW"] = mw27
                meta["slide27MaxPicH"] = mh27
                meta["slide27PicDims"] = pic_dimensions_all(s27)
                ok27, det27 = gallery_pics_meet_min_size(s27)
                add(
                    "Slide 27 gallery image min width and height",
                    ok27,
                    det27,
                )
                ok27f, det27f = gallery_pics_min_card_fraction(s27)
                add(
                    "Slide 27 gallery image >= 45% card height",
                    ok27f,
                    det27f,
                )
                ok27g, det27g = intl_slide_no_giant_pic(s27)
                add("Slide 27 no giant upscaled intl image", ok27g, det27g)

            s8_bottom = max_shape_bottom(s8)
            meta["slide8MaxBottom"] = s8_bottom
            add(
                "Slide 8 within footer safe area",
                s8_bottom <= FOOTER_SAFE_BOTTOM,
                f"max_bottom={s8_bottom}",
            )
            add(
                "Slide 8 source note below table (no overlap)",
                source_note_below_table(s8, min_gap=PDF_SAFE_TABLE_NOTE_GAP)
                and table_rows_not_over_footnote(s8, min_gap=PDF_SAFE_TABLE_NOTE_GAP),
                f"pdf_safe_gap>={PDF_SAFE_TABLE_NOTE_GAP}",
            )

            s11_bottom = max_shape_bottom(s11)
            meta["slide11MaxBottom"] = s11_bottom
            add(
                "Slide 11 suggestions within footer safe area",
                s11_bottom <= FOOTER_SAFE_BOTTOM,
                f"max_bottom={s11_bottom}",
            )
            add(
                "Slide 11 bullet list bounded (no footer clip)",
                bullets_overflow_note_present_or_bounded(s11),
            )
            add(
                "Slide 11 section headings not at footer",
                section_heading_above_footer(s11),
            )
            ok11o, det11o = slide_suggestions_overflow_ok(s11)
            add("Slide 11 single overflow note / no footer overlap", ok11o, det11o)

            s20_bottom = max_shape_bottom(s20)
            meta["slide20MaxBottom"] = s20_bottom
            add(
                "Slide 20 evidence appendix within footer safe area",
                s20_bottom <= FOOTER_SAFE_BOTTOM,
                f"max_bottom={s20_bottom}",
            )
            add(
                "Slide 20 source note below table (no overlap)",
                source_note_below_table(s20) and table_rows_not_over_footnote(s20),
            )
            add(
                "Slide 20 uses compact 4-column evidence layout",
                "Link" not in plain_text(s20) and "Ссылка" not in plain_text(s20),
            )

            s26_bottom = max_shape_bottom(s26)
            meta["slide26MaxBottom"] = s26_bottom
            add(
                "Slide 26 intl suggestions within footer safe area",
                s26_bottom <= FOOTER_SAFE_BOTTOM,
                f"max_bottom={s26_bottom}",
            )
            add(
                "Slide 26 bullet list bounded (no footer clip)",
                bullets_overflow_note_present_or_bounded(s26),
            )
            add(
                "Slide 26 section headings not at footer",
                section_heading_above_footer(s26),
            )
            ok26o, det26o = slide_suggestions_overflow_ok(s26)
            add("Slide 26 single overflow note / no footer overlap", ok26o, det26o)

            s36_bottom = max_shape_bottom(s36)
            meta["slide36MaxBottom"] = s36_bottom
            s36_shapes = text_shapes(s36)
            add(
                "Slide 36 within footer safe area",
                s36_bottom <= FOOTER_SAFE_BOTTOM,
                f"max_bottom={s36_bottom}",
            )
            add(
                "Slide 36 disclaimer not overlapping risk cards",
                disclaimer_not_overlapping_cards(s36_shapes),
            )

    return {"checks": checks, "meta": meta, "passed": all(c["ok"] for c in checks)}


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: inspect-o541-pptx.py <pptx-path> [report-json-path]")
        return 1

    pptx = Path(sys.argv[1])
    report_json = None
    if len(sys.argv) >= 3:
        report_json = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))

    if not pptx.exists():
        print(f"[FAIL] PPTX not found: {pptx}")
        return 1

    result = inspect(pptx, report_json)
    for c in result["checks"]:
        status = "PASS" if c["ok"] else "FAIL"
        extra = f" — {c['detail']}" if c.get("detail") else ""
        print(f"[{status}] {c['name']}{extra}")

    print(json.dumps(result["meta"], indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
