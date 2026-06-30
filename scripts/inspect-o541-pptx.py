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


def inspect(pptx: Path, report_json: dict | None = None) -> dict:
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
        confirmed_part = t20.split("Excluded")[0].split("исключ")[0]
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
