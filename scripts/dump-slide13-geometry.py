"""Dump slide 13 screenshot geometry from PPTX + write debug JSON/PNG."""
from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path

DEFAULT_PPTX = Path("storage/digital-profile/qa-v19-orion-slide13/report-v17-ru-internal-draft.pptx")
DEFAULT_JSON = Path("storage/digital-profile/qa-v19-orion-slide13/slide13-geometry-debug.json")
DEFAULT_PNG = Path("storage/digital-profile/qa-v19-orion-slide13/pages-pdf/page-13-debug-bboxes.png")
DEFAULT_PAGE = Path("storage/digital-profile/qa-v19-orion-slide13/pages-pdf/page-13.png")

CW = 8046720
LEFT_X = 548640
LEFT_W = int(CW * 0.45)
GUTTER = int(CW * 0.035)
RIGHT_X = LEFT_X + LEFT_W + GUTTER


def load_xml(pptx: Path) -> str:
    return zipfile.ZipFile(pptx).read("ppt/slides/slide13.xml").decode()


def sp_blocks(xml: str):
    for sp in re.findall(r"<p:sp\b.*?</p:sp>", xml, re.S):
        off = re.search(r'x="(\d+)" y="(\d+)"', sp)
        ext = re.search(r'cx="(\d+)" cy="(\d+)"', sp)
        if not off or not ext:
            continue
        x, y = int(off.group(1)), int(off.group(2))
        w, h = int(ext.group(1)), int(ext.group(2))
        texts = re.findall(r"<a:t>([^<]*)</a:t>", sp)
        text = " ".join(texts)
        prst = re.search(r'prst="([^"]+)"', sp)
        yield {
            "x": x,
            "y": y,
            "w": w,
            "h": h,
            "right": x + w,
            "bottom": y + h,
            "text": text[:80],
            "prst": prst.group(1) if prst else "",
            "round": "roundrect" in sp.lower(),
            "red": "FC3F1C" in sp.upper() or "E65C00" in sp.upper(),
        }


def pics(xml: str):
    for pic in re.findall(r"<p:pic\b.*?</p:pic>", xml, re.S):
        off = re.search(r'x="(\d+)" y="(\d+)"', pic)
        ext = re.search(r'cx="(\d+)" cy="(\d+)"', pic)
        if off and ext:
            x, y = int(off.group(1)), int(off.group(2))
            w, h = int(ext.group(1)), int(ext.group(2))
            yield {"x": x, "y": y, "w": w, "h": h, "right": x + w, "bottom": y + h}


def analyze(pptx: Path) -> dict:
    xml = load_xml(pptx)
    right_sp = [s for s in sp_blocks(xml) if s["x"] >= RIGHT_X - 100000]
    right_pics = [p for p in pics(xml) if p["x"] >= RIGHT_X - 100000]

    frames = [
        s
        for s in right_sp
        if s["round"] and s["w"] > 3000000 and s["h"] > 2000000 and s["y"] >= 1400000
    ]
    frame = max(frames, key=lambda s: s["w"] * s["h"]) if frames else None

    search = next(
        (
            s
            for s in right_sp
            if s["round"]
            and 155000 <= s["h"] <= 205000
            and s["w"] > 1500000
            and s["y"] >= 1500000
        ),
        None,
    )
    if not search:
        search = next((s for s in right_sp if "Томилин" in s["text"] or "Tomilin" in s["text"]), None)

    tabs = [s for s in right_sp if s["text"] in ("поиск", "картинки", "видео", "карты", "search", "images")]
    title = next((s for s in right_sp if s["text"] in ("Изображения", "Images")), None)
    badges = [s for s in right_sp if s["text"] == "×" and s["red"]]
    ya = next((s for s in right_sp if s["text"] == "Я" and s["red"]), None)

    if right_pics:
        top_left = min(right_pics, key=lambda p: (p["y"], p["x"]))
        bottom_right = max(right_pics, key=lambda p: (p["bottom"], p["right"]))
        grid = {
            "x": min(p["x"] for p in right_pics),
            "y": min(p["y"] for p in right_pics),
            "right": max(p["right"] for p in right_pics),
            "bottom": max(p["bottom"] for p in right_pics),
            "w": max(p["right"] for p in right_pics) - min(p["x"] for p in right_pics),
            "h": max(p["bottom"] for p in right_pics) - min(p["y"] for p in right_pics),
        }
        thumb_bboxes = right_pics
    else:
        top_left = bottom_right = grid = None
        thumb_bboxes = []

    if tabs:
        tabs_row = {
            "x": min(t["x"] for t in tabs),
            "y": min(t["y"] for t in tabs),
            "right": max(t["right"] for t in tabs),
            "bottom": max(t["bottom"] for t in tabs),
            "w": max(t["right"] for t in tabs) - min(t["x"] for t in tabs),
            "h": max(t["bottom"] for t in tabs) - min(t["y"] for t in tabs),
        }
    else:
        tabs_row = None

    out: dict = {
        "pptx": str(pptx),
        "OUTER_SCREENSHOT_FRAME": frame,
        "SEARCH_INPUT": search,
        "YANDEX_BADGE": ya,
        "TABS_ROW": tabs_row,
        "IMAGE_TITLE": title,
        "THUMBNAIL_GRID": grid,
        "TOP_LEFT_THUMBNAIL": top_left,
        "BOTTOM_RIGHT_THUMBNAIL": bottom_right,
        "THUMBNAIL_BBOXES": thumb_bboxes,
        "RED_BADGES": badges,
        "RED_BADGE_COUNT": len(badges),
    }

    if frame and search:
        out["insets"] = {
            "search_left": search["x"] - frame["x"],
            "search_top": search["y"] - frame["y"],
            "search_right": frame["right"] - search["right"],
            "thumb_top": (top_left["y"] - frame["y"]) if top_left else None,
            "thumb_left": (top_left["x"] - frame["x"]) if top_left else None,
            "frame_bottom_minus_last_thumb": (frame["bottom"] - bottom_right["bottom"]) if bottom_right else None,
            "frame_right_minus_last_thumb": (frame["right"] - bottom_right["right"]) if bottom_right else None,
        }
        if grid:
            out["insets"]["grid_left"] = grid["x"] - frame["x"]
            out["insets"]["grid_right"] = frame["right"] - grid["right"]
            out["insets"]["grid_bottom"] = frame["bottom"] - grid["bottom"]
    return out


def draw_debug_png(base_png: Path, geom: dict, out_png: Path) -> bool:
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return False
    if not base_png.is_file():
        return False
    img = Image.open(base_png).convert("RGBA")
    draw = ImageDraw.Draw(img)
    slide_w, slide_h = 9144000, 6858000
    sx = img.width / slide_w
    sy = img.height / slide_h

    def rect(box: dict | None, color: tuple[int, int, int, int], width: int = 3) -> None:
        if not box:
            return
        x0 = int(box["x"] * sx)
        y0 = int(box["y"] * sy)
        x1 = int(box["right"] * sx)
        y1 = int(box["bottom"] * sy)
        for i in range(width):
            draw.rectangle([x0 - i, y0 - i, x1 + i, y1 + i], outline=color)

    rect(geom.get("OUTER_SCREENSHOT_FRAME"), (0, 180, 0, 255), 4)
    rect(geom.get("SEARCH_INPUT"), (0, 120, 255, 255), 2)
    rect(geom.get("TABS_ROW"), (255, 180, 0, 255), 2)
    rect(geom.get("IMAGE_TITLE"), (180, 0, 255, 255), 2)
    rect(geom.get("THUMBNAIL_GRID"), (255, 0, 120, 255), 2)
    for b in geom.get("RED_BADGES") or []:
        rect(b, (255, 0, 0, 255), 2)
    out_png.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_png)
    return True


def main() -> None:
    pptx = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PPTX
    out_json = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_JSON
    geom = analyze(pptx)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(geom, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(geom, indent=2, ensure_ascii=False))
    if draw_debug_png(DEFAULT_PAGE, geom, DEFAULT_PNG):
        print(f"debug PNG -> {DEFAULT_PNG}")


if __name__ == "__main__":
    main()
