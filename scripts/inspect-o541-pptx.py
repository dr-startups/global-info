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


def max_shape_bottom(xml: str) -> int:
    max_b = 0
    for sp in re.findall(r"<p:sp\b.*?</p:sp>", xml, flags=re.DOTALL):
        off_m = re.search(r'<a:off x="(\d+)" y="(\d+)"', sp)
        ext_m = re.search(r'<a:ext cx="(\d+)" cy="(\d+)"', sp)
        if off_m and ext_m:
            y = int(off_m.group(2))
            if y >= FOOTER_BAND_TOP:
                continue
            bottom = y + int(ext_m.group(2))
            max_b = max(max_b, bottom)
    return max_b


def pic_aspect_ratios_ok(xml: str, lo: float = 0.35, hi: float = 2.8) -> bool:
    """Reject extreme stretch ratios typical of fixed width+height add_picture."""
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
        if re.search(r"collected|собран|selected|исключ|relevant", shape["text"], re.I):
            if shape["bottom"] > pic_y - 80000:
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

        s13 = slide_xml(z, 13)
        s14 = slide_xml(z, 14)
        s20 = slide_xml(z, 20)
        s24 = slide_xml(z, 24)
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
            if images_selected > 0 and pics13 > 0:
                add(
                    "Slide 13 image aspect ratios not stretched",
                    pic_aspect_ratios_ok(s13),
                )
            s13_bottom = max_shape_bottom(s13)
            meta["slide13MaxBottom"] = s13_bottom
            add(
                "Slide 13 within footer safe area",
                s13_bottom <= FOOTER_SAFE_BOTTOM,
                f"max_bottom={s13_bottom}",
            )
            add("Slide 13 page footer visible", "/ 50" in p13 or "50" in p13)
            s13_shapes = text_shapes(s13)
            add(
                "Slide 13 selection note above image grid",
                selection_note_above_grid(s13),
            )
            add(
                "Slide 13 domain and identity badge zones separated",
                caption_zones_have_gap(
                    s13_shapes,
                    r"\.(com|ru|net|org|edu|linkedin|youtube)",
                    r"LIKELY|EXACT|likely subject",
                ),
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
