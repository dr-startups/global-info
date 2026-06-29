"""Inspect R1.1 manual QA PPTX/PDF artifacts for forbidden content and layout markers."""

from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path

BAD = [
    re.compile(r"example\.com", re.I),
    re.compile(r"\.example\b", re.I),
    re.compile(r"\[DEMO\]", re.I),
    re.compile(r"\bmock:YANDEX\b", re.I),
    re.compile(r"\bmock:GOOGLE\b", re.I),
]

CLIENT_BAD = [
    re.compile(r"Demo/mock", re.I),
    re.compile(r"mock rows", re.I),
    re.compile(r"excluded from production report metrics", re.I),
    re.compile(r"\[DEMO\]", re.I),
    re.compile(r"\bfixture\b", re.I),
    re.compile(r"\binternal\b", re.I),
    re.compile(r"Совпадения в compliance-базах", re.I),
    re.compile(r"\bMOCK/DEMO\b", re.I),
    re.compile(r"\bmock agent\b", re.I),
    re.compile(r"api[_-]?key", re.I),
    re.compile(r"\bsecret\b", re.I),
    re.compile(r"ЧЕРНОВИК", re.I),
    re.compile(r"\bDRAFT\b"),
]

R1_MARKERS_RU = [
    "Комплаенс-базы — обзор",
    "Комплаенс-совпадения по типу риска",
    "Ключевые комплаенс-совпадения",
    "Проверка и качество данных",
]

R1_MARKERS_EN = [
    "Compliance databases — overview",
    "Compliance hits by risk type",
    "Top compliance matches",
    "Review & data quality",
]

OFFER_MARKERS = ["Solution 1", "Solution 2", "Solution 3", "Process / timeline", "Next step"]

CYRILLIC = re.compile(r"[\u0400-\u04FF]")


def slide_texts(pptx: Path) -> list[str]:
    texts: list[str] = []
    with zipfile.ZipFile(pptx, "r") as z:
        names = sorted(n for n in z.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml"))
        for name in names:
            raw = z.read(name).decode("utf-8", errors="ignore")
            plain = re.sub(r"<[^>]+>", " ", raw)
            plain = re.sub(r"\s+", " ", plain).strip()
            texts.append(plain)
    return texts


def pages_by_footer(pptx: Path) -> dict[int, str]:
    out: dict[int, str] = {}
    for plain in slide_texts(pptx):
        m = re.search(r"(\d+)\s*/\s*50", plain)
        if m:
            out[int(m.group(1))] = plain
    return out


def pdf_text(pdf: Path) -> str:
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        return ""
    reader = PdfReader(str(pdf))
    parts = []
    for page in reader.pages:
        parts.append(page.extract_text() or "")
    return "\n".join(parts)


def check_no_bad(label: str, text: str, patterns: list[re.Pattern[str]], slide_idx: int | None = None) -> bool:
    for pat in patterns:
        if pat.search(text):
            where = f"slide {slide_idx}" if slide_idx else label
            print(f"[FAIL] {where}: forbidden pattern {pat.pattern!r}")
            return False
    return True


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: inspect-qa-artifacts.py <artifacts-dir>")
        return 1

    root = Path(sys.argv[1])
    ru_pptx = root / "report-ru-internal-draft-v3.pptx"
    ru_pdf = root / "report-ru-internal-draft-v3.pdf"
    en_pptx = root / "report-en-client-none-v3.pptx"
    en_pdf = root / "report-en-client-none-v3.pdf"

    fails = 0

    if not ru_pptx.exists():
        print("[FAIL] RU PPTX missing")
        return 1

    ru_pages = pages_by_footer(ru_pptx)
    print(f"[INFO] RU PPTX footer pages: {len(ru_pages)}")
    if len(ru_pages) < 48:
        print(f"[FAIL] RU page count expected ~50 footer pages, got {len(ru_pages)}")
        fails += 1
    else:
        print("[PASS] RU PPTX ~50 pages")

    for idx in [8, 9, 20]:
        t = ru_pages.get(idx, "")
        ok = check_no_bad(f"RU page {idx}", t, BAD, idx) if t else False
        if not t:
            print(f"[FAIL] RU page {idx} missing")
            fails += 1
        else:
            print(f"[{'PASS' if ok else 'FAIL'}] RU page {idx} no example/demo/mock")
            if not ok:
                fails += 1

    s10 = ru_pages.get(10, "")
    serp_ok = bool(s10) and (
        "SERP" in s10
        or "Поисковая выдача" in s10
        or "search" in s10.lower()
        or "поиск" in s10.lower()
    )
    print(f"[{'PASS' if serp_ok else 'FAIL'}] RU page 10 SERP snapshot content")
    if not serp_ok:
        fails += 1

    block = " ".join(ru_pages.get(p, "") for p in range(32, 37))
    for marker in R1_MARKERS_RU:
        ok = marker in block
        print(f"[{'PASS' if ok else 'FAIL'}] R1 RU marker: {marker}")
        if not ok:
            fails += 1
    stub_ok = "не настроен" in block.lower() or "not configured" in block.lower()
    print(f"[{'PASS' if stub_ok else 'FAIL'}] RU compliance stubs not configured wording")
    if not stub_ok:
        fails += 1

    ru_pdf_text = pdf_text(ru_pdf) if ru_pdf.exists() else ""
    if ru_pdf_text:
        ok = check_no_bad("RU PDF pages 8-20 region", ru_pdf_text, BAD)
        print(f"[{'PASS' if ok else 'FAIL'}] RU PDF no example/demo patterns")
        if not ok:
            fails += 1
    else:
        print("[INFO] RU PDF text skip (pypdf unavailable or empty)")

    en_pages = pages_by_footer(en_pptx)
    print(f"[INFO] EN PPTX footer pages: {len(en_pages)}")
    if len(en_pages) < 48:
        print(f"[FAIL] EN page count expected ~50 footer pages, got {len(en_pages)}")
        fails += 1
    else:
        print("[PASS] EN PPTX ~50 pages")

    en_all = " ".join(en_pages.values())
    for pat in CLIENT_BAD:
        if pat.search(en_all):
            print(f"[FAIL] EN client deck forbidden: {pat.pattern!r}")
            fails += 1
        else:
            print(f"[PASS] EN no {pat.pattern!r}")

    p3 = en_pages.get(3, "")
    p3_ok = bool(p3) and not any(p.search(p3) for p in CLIENT_BAD[:6])
    print(f"[{'PASS' if p3_ok else 'FAIL'}] EN page 3 no demo/mock/internal hygiene bullet")
    if not p3_ok:
        fails += 1

    p10 = en_pages.get(10, "")
    p10_ok = bool(p10) and "Demo/mock data is used" not in p10 and not re.search(r"Demo/mock", p10, re.I)
    print(f"[{'PASS' if p10_ok else 'FAIL'}] EN page 10 client-safe SERP caption")
    if not p10_ok:
        fails += 1

    p35 = en_pages.get(35, "")
    p35_ok = bool(p35) and not CYRILLIC.search(p35) and "require analyst review" in p35
    print(f"[{'PASS' if p35_ok else 'FAIL'}] EN page 35 English compliance warning, no Cyrillic")
    if not p35_ok:
        fails += 1

    block_en = " ".join(en_pages.get(p, "") for p in range(32, 37))
    for marker in R1_MARKERS_EN:
        ok = marker.replace("&amp;", "&") in block_en.replace("&amp;", "&") or marker in block_en
        print(f"[{'PASS' if ok else 'FAIL'}] R1 EN marker: {marker}")
        if not ok:
            fails += 1

    offer = " ".join(en_pages.get(p, "") for p in range(38, 51))
    for marker in OFFER_MARKERS:
        ok = marker in offer
        print(f"[{'PASS' if ok else 'FAIL'}] EN offer marker: {marker}")
        if not ok:
            fails += 1

    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
