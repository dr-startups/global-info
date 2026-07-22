"""ORION Golden Report renderer — shared theme, fonts, layout, and canvas helpers.
Split from orion_golden_renderer.py (REMEDIATION §9.5) — mechanical move only.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

import fitz
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Pt

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None  # type: ignore

try:
    from client_text_contract import (
        renderer_strip_re,
        resolve_contract,
        sidebar_check_failures,
    )
except ImportError:  # pragma: no cover — package-style import inside container
    from renderer.client_text_contract import (  # type: ignore
        renderer_strip_re,
        resolve_contract,
        sidebar_check_failures,
    )

FONT = "DejaVu Sans"
FS_TITLE = 26
FS_SECTION = 22
FS_SUBTITLE = 13
FS_BODY = 11  # min readable body ≥ 10.5pt
FS_CAPTION = 9  # footer/provenance 8.5–9pt

# Master slide 16:10 (12.8" × 8.0") — matches ORION reference aspect.
SLIDE_W = 11_704_320
SLIDE_H = 7_315_200
MARGIN_X = 480_000
CONTENT_W = SLIDE_W - 2 * MARGIN_X
FOOTER_Y = SLIDE_H - 440_000
# PDF-46 I.2 — hard clearance above confidential footer (measure underestimates
# multi-line theme cards; keep a wide safety band).
CONTENT_BOTTOM = SLIDE_H - 1_100_000

NAVY = RGBColor(0x0B, 0x1A, 0x33)
TITLE_COLOR = RGBColor(0xF8, 0xFA, 0xFC)
BODY_COLOR = RGBColor(0x33, 0x41, 0x55)
MUTED_COLOR = RGBColor(0x64, 0x74, 0x8B)
ACCENT = RGBColor(0x3B, 0x82, 0xF6)
CARD_BG = RGBColor(0xF8, 0xFA, 0xFC)
CARD_BORDER = RGBColor(0xE2, 0xE8, 0xF0)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
ACCENT_SOFT = RGBColor(0xEF, 0xF6, 0xFF)
WARN_BG = RGBColor(0xFF, 0xF7, 0xED)
RISK_BG = RGBColor(0xFE, 0xF2, 0xF2)
GOOD_BG = RGBColor(0xEC, 0xFD, 0xF5)
TONE_RISK = RGBColor(0xB9, 0x1C, 0x1C)
TONE_WARN = RGBColor(0xC2, 0x41, 0x0C)
TONE_GOOD = RGBColor(0x04, 0x78, 0x57)
# ORION Golden design system v2: premium gold accent + dark-page hairlines.
GOLD = RGBColor(0xC0, 0x9A, 0x4F)
DARK_RULE = RGBColor(0x24, 0x33, 0x52)

# REMEDIATION §6.1 — pattern sourced from client_text_contract.json
FORBIDDEN = renderer_strip_re()

# EMU helpers: 914400 EMU = 1 inch; 72 pt = 1 inch
EMU_PER_PT = 12_700
EMU_PER_INCH = 914_400

# Renderer-side text layout telemetry (page, font, box, measured vs available).
_LAYOUT_TELEMETRY: list[dict[str, Any]] = []


def reset_layout_telemetry() -> None:
    _LAYOUT_TELEMETRY.clear()


def get_layout_telemetry() -> list[dict[str, Any]]:
    return list(_LAYOUT_TELEMETRY)


def record_text_layout(
    *,
    page: int,
    name: str,
    role: str,
    font_family: str,
    font_size_pt: float,
    box_width: int,
    box_height: int,
    available_height: int,
    required_height: int,
    measured_lines: int,
    text_length: int,
    clipped: bool,
    measurement_uncertain: bool = False,
) -> None:
    _LAYOUT_TELEMETRY.append(
        {
            "page": page,
            "name": name,
            "role": role,
            "fontFamily": font_family,
            "fontSizePt": font_size_pt,
            "boxWidth": box_width,
            "boxHeight": box_height,
            "availableHeight": available_height,
            "requiredHeight": required_height,
            "measuredLines": measured_lines,
            "textLength": text_length,
            "clipped": clipped,
            "measurementUncertain": measurement_uncertain,
        }
    )


def _count_measured_lines(
    text: str,
    width_emu: int,
    font_size_pt: float,
) -> tuple[int, bool]:
    """Return (line_count, measurement_uncertain)."""
    raw = _safe(text)
    if not raw:
        return 1, False
    width_px = max(40, int(width_emu / EMU_PER_INCH * 96 * 0.90))
    paragraphs = [p.strip() for p in re.split(r"\n+", raw) if p.strip()] or [""]
    total_lines = 0
    uncertain = False
    font = None
    if Image is not None:
        try:
            from PIL import ImageFont  # type: ignore

            fp = _font_path()
            if fp:
                font = ImageFont.truetype(fp, size=max(8, int(round(font_size_pt * 96 / 72))))
            else:
                uncertain = True
        except Exception:  # noqa: BLE001
            uncertain = True
            font = None
    else:
        uncertain = True

    for para in paragraphs:
        words = para.split(" ")
        if not words:
            total_lines += 1
            continue
        line = ""
        lines = 1
        for word in words:
            trial = word if not line else f"{line} {word}"
            if font is not None:
                try:
                    bbox = font.getbbox(trial)
                    tw = bbox[2] - bbox[0]
                except Exception:  # noqa: BLE001
                    tw = int(len(trial) * font_size_pt * 0.58 * 96 / 72)
                    uncertain = True
            else:
                tw = int(len(trial) * font_size_pt * 0.58 * 96 / 72)
            if tw <= width_px or not line:
                line = trial
            else:
                lines += 1
                line = word
        total_lines += max(1, lines)
    return max(1, total_lines), uncertain


def _font_path() -> str | None:
    """Return DejaVu Sans file used for both measurement and PPTX family."""
    here = Path(__file__).resolve().parent
    candidates = [
        os.environ.get("ORION_RENDER_FONT"),
        str(here / "fonts" / "DejaVuSans.ttf"),
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        r"C:\Windows\Fonts\DejaVuSans.ttf",
    ]
    for path in candidates:
        if path and Path(path).is_file():
            return path
    return None


def assert_render_font_family() -> str:
    """Startup/QA: measurement font must be DejaVu Sans family."""
    fp = _font_path()
    if not fp:
        raise RuntimeError("ORION render font missing: expected DejaVuSans.ttf under renderer/fonts")
    name = Path(fp).name.lower()
    if "dejavu" not in name:
        raise RuntimeError(f"ORION render font mismatch: expected DejaVu Sans, got {fp}")
    # Optional Linux check
    try:
        import subprocess

        out = subprocess.check_output(["fc-match", "DejaVu Sans"], text=True, stderr=subprocess.DEVNULL)
        if "DejaVu" not in out and "dejavu" not in out.lower():
            raise RuntimeError(f"fc-match DejaVu Sans unexpected: {out.strip()}")
    except FileNotFoundError:
        pass
    except subprocess.CalledProcessError:
        pass
    return fp


def measure_text_height(
    text: str,
    width_emu: int,
    font_size_pt: float,
    line_spacing: float = 1.2,
    paragraph_spacing_pt: float = 6.0,
) -> int:
    """Measure wrapped text height in EMU using real font metrics when available."""
    raw = _safe(text)
    if not raw:
        return int(font_size_pt * EMU_PER_PT * line_spacing)
    # Slightly narrower than box so PPTX wrap is not underestimated.
    width_px = max(40, int(width_emu / EMU_PER_INCH * 96 * 0.90))
    paragraphs = [p.strip() for p in re.split(r"\n+", raw) if p.strip()] or [""]
    total_lines = 0
    font = None
    if Image is not None:
        try:
            from PIL import ImageFont  # type: ignore

            fp = _font_path()
            if fp:
                font = ImageFont.truetype(fp, size=max(8, int(round(font_size_pt * 96 / 72))))
        except Exception:  # noqa: BLE001
            font = None

    for para in paragraphs:
        words = para.split(" ")
        if not words:
            total_lines += 1
            continue
        line = ""
        lines = 1
        for word in words:
            trial = word if not line else f"{line} {word}"
            if font is not None:
                try:
                    bbox = font.getbbox(trial)
                    tw = bbox[2] - bbox[0]
                except Exception:  # noqa: BLE001
                    tw = int(len(trial) * font_size_pt * 0.58 * 96 / 72)
            else:
                tw = int(len(trial) * font_size_pt * 0.58 * 96 / 72)
            if tw <= width_px or not line:
                line = trial
            else:
                lines += 1
                line = word
        total_lines += max(1, lines)

    line_h = font_size_pt * EMU_PER_PT * line_spacing
    para_extra = max(0, len(paragraphs) - 1) * paragraph_spacing_pt * EMU_PER_PT
    # Safety margin: PPTX wraps more aggressively than PIL metrics.
    return int((total_lines * line_h + para_extra) * 1.18)


def _fit_text_to_height(
    text: str,
    width_emu: int,
    font_size_pt: float,
    max_h: int,
    *,
    line_spacing: float = 1.2,
) -> str:
    """Clip text so measured height fits max_h. Prefer complete sentences; never bare ellipsis stubs."""
    raw = _safe(text)
    if not raw:
        return ""
    if measure_text_height(raw, width_emu, font_size_pt, line_spacing=line_spacing) <= max_h:
        return raw
    # Prefer longest prefix that ends on a sentence boundary.
    sentences = re.split(r"(?<=[.!?…])\s+", raw)
    kept: list[str] = []
    for sent in sentences:
        trial = " ".join(kept + [sent]).strip()
        if measure_text_height(trial, width_emu, font_size_pt, line_spacing=line_spacing) <= max_h:
            kept.append(sent)
        else:
            break
    if kept:
        return " ".join(kept).strip()
    # Fall back to word clip without ellipsis; stop before dangling prepositions.
    words = raw.split()
    lo, hi = 1, len(words)
    best = words[0]
    while lo <= hi:
        mid = (lo + hi) // 2
        trial = " ".join(words[:mid])
        if measure_text_height(trial, width_emu, font_size_pt, line_spacing=line_spacing) <= max_h:
            best = trial
            lo = mid + 1
        else:
            hi = mid - 1
    return _trim_dangling_tail(best)


_DANGLING_TAIL = re.compile(
    r"(\s+(?:и|а|или|по|на|в|с|из|для|о|об|к|ко|у|от|до|при|без|над|под|про|через|как|что|чтобы|который|которая|которые|которых|баз|записям|доменом?|контекстом?|криминальным|компрометирующим|санкционным|нежелательный|ручной|негативным|т\.?\s*ч\.?))\s*$|"
    r"(\s+в\s+т\.?\s*ч\.?\s*$)|(\s+с\s+[А-ЯA-Z]\.?\s*$)|(\s+[А-ЯA-Z]\.?\s*$)",
    re.I,
)


def _trim_dangling_tail(text: str) -> str:
    val = text.strip()
    end = ""
    if val and val[-1] in ".!?…":
        end = val[-1]
        val = val[:-1].rstrip(".,;: ")
    for _ in range(4):
        nxt = _DANGLING_TAIL.sub("", val).rstrip(".,;: ")
        if nxt == val:
            break
        val = nxt
    if not val:
        return ""
    return val + end


def _safe(text: object) -> str:
    val = re.sub(r"\s+", " ", str(text or "")).strip()
    val = FORBIDDEN.sub("", val)
    # Humanize residual enum-like tokens that may appear in summaries
    val = re.sub(r"\bWRONG[_\s-]?SUBJECT\b", "другой субъект", val, flags=re.I)
    val = re.sub(r"\bPENDING\b", "требует проверки", val, flags=re.I)
    val = re.sub(r"\bGPT\b", "модельный анализ", val)
    val = re.sub(r"\bVISUAL_ASSET_UNAVAILABLE\b", "визуальный экспорт недоступен", val, flags=re.I)
    val = re.sub(r"\bLEXISNEXIS_SIGNAL\b", "сигнал LexisNexis", val, flags=re.I)
    val = re.sub(r"\bPotential match\b", "Потенциальное совпадение", val, flags=re.I)
    return val.strip()


def _safe_preserve_breaks(text: object) -> str:
    """Like _safe, but keeps intentional newlines for structured theme cards."""
    raw = str(text or "").replace("\r\n", "\n")
    parts = []
    for ln in raw.split("\n"):
        cleaned = _safe(ln)
        if cleaned:
            parts.append(cleaned)
    return "\n".join(parts)


def plural_ru(n: int, one: str, few: str, many: str) -> str:
    """Russian plural agreement: 1 сигнал / 2–4 сигнала / 5+ сигналов."""
    abs_n = abs(int(n)) % 100
    last = abs_n % 10
    if 10 < abs_n < 20:
        return many
    if last == 1:
        return one
    if 2 <= last <= 4:
        return few
    return many


def _clip_words(text: str, max_chars: int) -> str:
    """Emergency brake only (PDF-36 D.4): drop the incomplete last sentence
    whole whenever a complete one fits — a shorter finished thought beats a
    longer broken one. Word-boundary cut is the last resort."""
    val = _safe(text)
    if len(val) <= max_chars:
        return _trim_dangling_tail(val)
    slice_ = val[:max_chars]
    punct = max(slice_.rfind(". "), slice_.rfind("! "), slice_.rfind("? "), slice_.rfind("; "))
    # Any complete sentence ≥20% of the budget wins over a broken tail.
    if punct > max_chars * 0.2:
        return slice_[: punct + 1].rstrip()
    sp = max(slice_.rfind(" "), slice_.rfind("\u00a0"))
    if sp > max_chars * 0.4:
        return _trim_dangling_tail(slice_[:sp])
    soft = re.sub(r"[^\s]{1,12}$", "", slice_).rstrip()
    if len(soft) > max_chars * 0.35:
        return _trim_dangling_tail(soft)
    return _trim_dangling_tail(slice_)


_META_LINE_RE = re.compile(
    r"^(Источники(?:\s+в\s+регионе)?|Примеры(?:\s+заголовков)?|Где видно|В корпусе|Всего по теме|Пример)\s*:",
    re.I,
)
# Allow one level of nested guillemets: «Экс-владелец «Главстроя»».
_QUOTE_BODY = r"(?:[^«»]|«[^»]*»)+"
_QUOTE_SOURCE_RE = re.compile(rf"^«{_QUOTE_BODY}»\s*—\s*источник\b", re.I)
_THEME_LINE_RE = re.compile(r"^«[^»]{2,80}»\s*$")


_QUOTE_SOURCE_INLINE_RE = re.compile(
    rf"«{_QUOTE_BODY}»\s*—\s*источник\s+[A-Za-z0-9][A-Za-z0-9.-]*",
    re.I,
)
_TAIL_SPLIT_RE = re.compile(
    r"(?=(?:Всего по теме:|В корпусе:|Где видно:|Что делать:|Для банка|Банки |Это усиливает|Риск в том|Деловой фон))"
)


def _reflow_g2b_bullet(raw: str) -> list[str] | None:
    """PDF-43 — restore theme / framing / quotes / scale when GPT flattened G.2b."""
    flat = re.sub(r"\s+", " ", raw.replace("\n", " ")).strip()
    if not flat:
        return None
    quotes = _QUOTE_SOURCE_INLINE_RE.findall(flat)
    if not quotes:
        return None
    theme = ""
    rest = flat
    theme_m = re.match(r"^(«[^»]{2,80}»)\s+(.*)$", flat)
    if (
        theme_m
        and "источник" not in theme_m.group(1).lower()
        and re.match(r"^(Найдены|Есть публикации|В открытой)", theme_m.group(2))
    ):
        theme = theme_m.group(1).strip()
        rest = theme_m.group(2).strip()
        quotes = _QUOTE_SOURCE_INLINE_RE.findall(rest)
    first = _QUOTE_SOURCE_INLINE_RE.search(rest)
    if not first:
        return None
    framing = rest[: first.start()].strip()
    if framing and re.search(r"Найдены|публик|материал", framing, re.I) and not framing.endswith(":"):
        framing = re.sub(r"[.:]\s*$", "", framing) + ":"
    last_end = 0
    for m in _QUOTE_SOURCE_INLINE_RE.finditer(rest):
        last_end = m.end()
    tail = rest[last_end:].strip()
    out: list[str] = []
    if theme:
        out.append(theme)
    if framing:
        out.append(framing)
    out.extend(q.strip() for q in quotes)
    if tail:
        out.extend(p.strip() for p in _TAIL_SPLIT_RE.split(tail) if p.strip())
    return out if len(out) >= 3 else None


def _normalize_nested_guillemets(text: str) -> str:
    """«Экс-владелец «Главстроя»» → «Экс-владелец \"Главстроя\"» for stable quote parse."""
    prev = None
    out = text
    while prev != out:
        prev = out
        out = re.sub(r"«([^«»]*)«([^»]+)»([^»]*)»", r'«\1"\2"\3»', out)
    return out


def _split_structured_bullet(text: str) -> list[str]:
    """PDF-38 F.1 / PDF-43 — normalize a theme bullet into theme / quotes / meta lines."""
    # PDF-47 — never flatten newlines here (_safe would glue G.2b into one line).
    raw = _normalize_nested_guillemets(_safe_preserve_breaks(text)).strip()
    if not raw:
        return []
    # Strip trailing finding marker before structural split (kept out of draw lines).
    raw_core = re.sub(r"\s*\[finding-[^\]]+\]\s*$", "", raw).strip() or raw
    lines_in = [ln.strip() for ln in raw_core.split("\n") if ln.strip()]
    needs_reflow = False
    for ln in lines_in:
        n = len(_QUOTE_SOURCE_INLINE_RE.findall(ln))
        if n > 1:
            needs_reflow = True
            break
        if n == 1 and re.search(
            r"(?:Всего по теме:|В корпусе:|Где видно:|Для банка|Банки |Риск в том|Что делать:)",
            ln,
        ):
            needs_reflow = True
            break
        if re.match(r"^«[^»]{2,80}»\s+(?:Найдены|Есть публикации|В открытой)", ln):
            needs_reflow = True
            break
    if needs_reflow or ("\n" not in raw_core and _QUOTE_SOURCE_INLINE_RE.search(raw_core)):
        reflowed = _reflow_g2b_bullet(raw_core)
        if reflowed:
            return reflowed
    if "\n" in raw_core:
        return lines_in
    # One-line «Theme» — body with optional Sources/Examples tails.
    m = re.match(r"^(«[^»]+»)\s*[—\-–:]?\s*(.+)$", raw_core, re.S)
    if m:
        theme, rest = m.group(1).strip(), m.group(2).strip()
        sources = re.search(
            r"(Источники(?:\s+в\s+регионе)?:\s*.+?)(?=\s*Примеры|\s*$)", rest, re.I
        )
        examples = re.search(r"((?:Примеры(?:\s+заголовков)?):\s*.+)$", rest, re.I)
        stats = rest
        if sources:
            stats = stats.replace(sources.group(0), "").strip()
        if examples:
            stats = stats.replace(examples.group(0), "").strip()
        stats = re.sub(r"\s+", " ", stats).strip(" ;,.")
        if stats and not re.search(r"[.!?…]$", stats):
            stats = f"{stats}."
        lines = [theme]
        if stats:
            lines.append(stats)
        if sources:
            lines.append(re.sub(r"\s+", " ", sources.group(1)).strip())
        if examples:
            lines.append(
                re.sub(r"\s+", " ", examples.group(1)).replace("Примеры заголовков:", "Примеры:").strip()
            )
        return lines
    return [raw_core]


def _clip_structured_bullet(text: str, max_chars: int) -> str:
    """Keep whole structural lines only — never mid-cut a quote/phrase (PDF-45/46)."""
    lines = _split_structured_bullet(text)
    if not lines:
        return ""
    # Drop empty / broken GPT stubs («Что делать:.», «контекстом —.», «Где видно:.»).
    cleaned: list[str] = []
    for ln in lines:
        if re.match(r"^(Что делать|Всего по теме|В корпусе|Где видно)\s*:\s*\.?$", ln, re.I):
            continue
        if re.search(r",\s*с негативным контекстом\s+[—–-]\s*\.?$", ln, re.I):
            continue
        # PDF-49 — dangling token must follow « or whitespace (not «…Дерипаски»).
        if re.search(
            r"«.*(?:«|\s)(?:из-за|и|в|во|на|по|с|со|о|об|and|or|of|the|to|for|with|from|by|over)\s*»",
            ln,
            re.I | re.S,
        ):
            continue
        # PDF-48 — drop quotes that end on a comma/colon stub («…Дерипаски,»).
        if re.search(r"«[^»]*[,;:]\s*»", ln):
            continue
        cleaned.append(ln)
    lines = cleaned
    if not lines:
        return ""
    if sum(len(ln) for ln in lines) + max(0, len(lines) - 1) <= max_chars:
        return "\n".join(lines)
    kept: list[str] = []
    used = 0
    for ln in lines:
        sep = 1 if kept else 0
        room = max_chars - used - sep
        if room < 12:
            break
        if len(ln) <= room:
            kept.append(ln)
            used += sep + len(ln)
            continue
        # Quote / theme / meta: skip whole line rather than publish «…visa over».
        if _QUOTE_SOURCE_RE.match(ln) or ln.startswith("«") or _META_LINE_RE.match(ln):
            break
        # Non-quote prose: only keep if a complete sentence fits.
        punct = max(ln.rfind(". "), ln.rfind("! "), ln.rfind("? "))
        if punct > 20 and punct + 1 <= room:
            kept.append(ln[: punct + 1].strip())
        break
    # Never fall back to a mid-word / mid-phrase slice of the first line.
    return "\n".join(kept)


def _bullet_line_style(line: str, *, is_first: bool) -> tuple[bool, RGBColor, float]:
    """Return (bold, color, size_pt) for one line inside a structured bullet."""
    if _META_LINE_RE.match(line):
        return False, MUTED_COLOR, FS_CAPTION + 0.5
    # Concrete evidence quotes are body text, not theme headers.
    if _QUOTE_SOURCE_RE.match(line):
        return False, BODY_COLOR, float(FS_BODY)
    if is_first and (_THEME_LINE_RE.match(line) or (line.endswith(":") and len(line) <= 80)):
        return True, NAVY, FS_BODY + 0.5
    if is_first and line.startswith("«") and "»" in line[:90] and "источник" not in line.lower():
        return True, NAVY, FS_BODY + 0.5
    return False, BODY_COLOR, float(FS_BODY)


# REMEDIATION §6.2 — replace QA-violating sidebar fields; never fail the whole render.

SIDEBAR_SAFE_FALLBACK = "См. таблицу результатов на этой странице."


class _Ctx:
    def __init__(
        self,
        prs: Presentation,
        page: int,
        total: int,
        *,
        client_text_contract: dict[str, Any] | None = None,
    ):
        self.prs = prs
        self.page = page
        self.total = total
        self.client_text_contract = resolve_contract(client_text_contract)
        self.warnings: list[str] = []
        self.dark = False
        layout = prs.slide_layouts[6] if len(prs.slide_layouts) > 6 else prs.slide_layouts[0]
        self.slide = prs.slides.add_slide(layout)

    def footer(self) -> None:
        # Hairline rule + brand line left, page counter right (design v2).
        rule = self.slide.shapes.add_shape(
            1, Emu(MARGIN_X), Emu(FOOTER_Y - 40_000), Emu(CONTENT_W), Emu(12_700)
        )
        rule.fill.solid()
        rule.fill.fore_color.rgb = DARK_RULE if self.dark else CARD_BORDER
        rule.line.fill.background()
        brand = self.slide.shapes.add_textbox(
            Emu(MARGIN_X), Emu(FOOTER_Y), Emu(CONTENT_W // 2), Emu(250000)
        )
        bp = brand.text_frame.paragraphs[0]
        br = bp.add_run()
        br.text = "ORION · Конфиденциально"
        br.font.name = FONT
        br.font.size = Pt(FS_CAPTION)
        br.font.color.rgb = MUTED_COLOR
        box = self.slide.shapes.add_textbox(Emu(MARGIN_X), Emu(FOOTER_Y), Emu(CONTENT_W), Emu(250000))
        try:
            box.name = f"orion_footer_p{self.page}"
        except Exception:  # noqa: BLE001
            pass
        tf = box.text_frame
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.RIGHT
        r = p.add_run()
        r.text = f"{self.page} / {self.total}"
        r.font.name = FONT
        r.font.size = Pt(FS_CAPTION)
        r.font.color.rgb = MUTED_COLOR

    def dark_bg(self) -> None:
        self.dark = True
        fill = self.slide.background.fill
        fill.solid()
        fill.fore_color.rgb = NAVY

    def light_bg(self) -> None:
        self.dark = False
        fill = self.slide.background.fill
        fill.solid()
        fill.fore_color.rgb = WHITE

    def title(
        self,
        text: str,
        y: int = 280000,
        color: RGBColor = TITLE_COLOR,
        size: int = FS_TITLE,
        *,
        accent: bool = True,
    ) -> int:
        # Gold accent tick aligned with the first title line (design v2).
        text_x = MARGIN_X
        text_w = CONTENT_W
        if accent:
            bar_h = int(size * EMU_PER_PT * 1.05)
            bar = self.slide.shapes.add_shape(
                5, Emu(MARGIN_X), Emu(y + 55_000), Emu(55_000), Emu(bar_h)
            )
            bar.fill.solid()
            bar.fill.fore_color.rgb = GOLD
            bar.line.fill.background()
            text_x = MARGIN_X + 165_000
            text_w = CONTENT_W - 165_000
        box = self.slide.shapes.add_textbox(Emu(text_x), Emu(y), Emu(text_w), Emu(900000))
        tf = box.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        r = p.add_run()
        r.text = _safe(text)
        r.font.name = FONT
        r.font.bold = True
        r.font.size = Pt(size)
        r.font.color.rgb = color
        return y + 950000

    def card(
        self,
        y: int,
        h: int = 2_200_000,
        *,
        x: int | None = None,
        w: int | None = None,
        fill: RGBColor = CARD_BG,
        border: RGBColor | None = CARD_BORDER,
        radius: float = 0.055,
    ) -> None:
        left = MARGIN_X if x is None else x
        width = CONTENT_W if w is None else w
        avail = max(200_000, min(h, CONTENT_BOTTOM - y))
        # 5 = rounded rectangle: soft corners across every card (design v2).
        shape = self.slide.shapes.add_shape(5, Emu(left), Emu(y), Emu(width), Emu(avail))
        try:
            shape.adjustments[0] = radius
        except Exception:  # noqa: BLE001
            pass
        try:
            shape.name = f"orion_card_p{self.page}"
        except Exception:  # noqa: BLE001
            pass
        shape.fill.solid()
        shape.fill.fore_color.rgb = fill
        if border is None:
            shape.line.fill.background()
        else:
            shape.line.color.rgb = border
            shape.line.width = Pt(0.75)

    def body(
        self,
        text: str,
        y: int,
        max_h: int = 900000,
        color: RGBColor = BODY_COLOR,
        *,
        x: int | None = None,
        w: int | None = None,
        font_size: int = FS_BODY,
    ) -> int:
        """Render body text and return actual bottom Y from measured content height."""
        left = MARGIN_X if x is None else x
        width = CONTENT_W if w is None else w
        avail = max(200000, min(max_h, CONTENT_BOTTOM - y))
        chunks = [c.strip() for c in re.split(r"\n+", _safe(text)) if c.strip()]
        if not chunks:
            return y
        # Prefer height-fit over crude char starvation (was ~200 chars at 420k emu).
        joined_raw = "\n".join(chunks[:8])
        # PDF-36 D.3 — before dropping sentences, shrink the font 1–2 pt
        # (min 9pt): full text at 10pt beats a cut paragraph at 11pt.
        if measure_text_height(joined_raw, width, font_size, line_spacing=1.2) > avail:
            for candidate in (font_size - 1, font_size - 2):
                if candidate < 9:
                    break
                if measure_text_height(joined_raw, width, candidate, line_spacing=1.2) <= avail:
                    font_size = candidate
                    break
        fitted = _fit_text_to_height(joined_raw, width, font_size, avail, line_spacing=1.2)
        fitted = _trim_dangling_tail(fitted)
        dangling = re.compile(
            r"(?:\bв\s+т\.?\s*ч\.?|\bс\s+[А-ЯA-Z]\.?|\b(?:как|что|чтобы|и|а|или|по|на|в|с)\b|,|;|—|–|-)\s*$",
            re.I,
        )
        if dangling.search(fitted) or (fitted and fitted[-1] not in ".!?…»)"):
            sentences = re.split(r"(?<=[.!?…])\s+", _safe(joined_raw))
            kept_s: list[str] = []
            for sent in sentences:
                trial = " ".join(kept_s + [sent]).strip()
                if measure_text_height(trial, width, font_size, line_spacing=1.2) <= avail:
                    kept_s.append(sent)
                else:
                    break
            # Drop a trailing incomplete clause (e.g. ends with «как»).
            while kept_s and (
                dangling.search(kept_s[-1]) or kept_s[-1][-1] not in ".!?…»)"
            ):
                kept_s.pop()
            if kept_s:
                fitted = " ".join(kept_s).strip()
            else:
                # Last resort: first sentence trimmed of dangling tail.
                first = _trim_dangling_tail(sentences[0] if sentences else fitted)
                fitted = first if first and not dangling.search(first) else _trim_dangling_tail(fitted)
        kept = [c for c in fitted.split("\n") if c.strip()] or ([fitted] if fitted else [])
        if not kept:
            return y
        joined = "\n".join(kept)
        needed = measure_text_height(joined, width, font_size, line_spacing=1.2, paragraph_spacing_pt=8)
        box_h = min(avail, max(needed + 40_000, int(font_size * EMU_PER_PT)))
        measured_lines, uncertain = _count_measured_lines(joined, width, font_size)
        # Clipping = placed text does not fit the box. Fitting/truncating source is not layout overflow.
        clipped = needed > avail
        record_text_layout(
            page=self.page,
            name=f"orion_text_body_p{self.page}",
            role="text",
            font_family=FONT,
            font_size_pt=font_size,
            box_width=width,
            box_height=box_h,
            available_height=avail,
            required_height=needed,
            measured_lines=measured_lines,
            text_length=len(joined),
            clipped=clipped,
            measurement_uncertain=uncertain,
        )
        box = self.slide.shapes.add_textbox(Emu(left), Emu(y), Emu(width), Emu(box_h))
        try:
            box.name = f"orion_text_body_p{self.page}"
        except Exception:  # noqa: BLE001
            pass
        tf = box.text_frame
        tf.word_wrap = True
        first = True
        for chunk in kept:
            p = tf.paragraphs[0] if first else tf.add_paragraph()
            first = False
            p.space_after = Pt(8)
            r = p.add_run()
            r.text = chunk
            r.font.name = FONT
            r.font.size = Pt(font_size)
            r.font.color.rgb = color
        return y + box_h

    def content_card(
        self,
        *,
        title: str | None,
        text: str,
        x: int,
        y: int,
        width: int,
        min_h: int = 320_000,
        max_h: int = 2_400_000,
        padding: int = 100_000,
        tone: str = "neutral",
        title_size: int = 10,
        body_size: int = 11,
    ) -> int:
        """Draw a content-sized card; clip text to fit; return actual bottom Y."""
        fill = {
            "accent": ACCENT_SOFT,
            "warn": WARN_BG,
            "risk": RISK_BG,
            "good": GOOD_BG,
        }.get(tone, CARD_BG)
        # Design v2: card titles pick up the tone colour instead of flat navy.
        title_color = {
            "accent": RGBColor(0x1D, 0x4E, 0xD8),
            "warn": TONE_WARN,
            "risk": TONE_RISK,
            "good": TONE_GOOD,
        }.get(tone, NAVY)
        title_s = _safe(title or "")
        # PDF-45 — keep structured theme newlines (quotes / scale) inside cards.
        body_s = _safe_preserve_breaks(text) if "\n" in str(text or "") else _safe(text)
        budget = max(200_000, min(max_h, CONTENT_BOTTOM - y))
        # Shrink padding on short cards so body text is not starved to a stub line.
        pad = padding
        if budget < 420_000:
            pad = min(padding, 60_000)
        elif budget < 560_000:
            pad = min(padding, 80_000)
        inner_w = max(120_000, width - 2 * pad)
        title_h = 0
        if title_s:
            title_h = measure_text_height(title_s, inner_w, title_size, line_spacing=1.15) + 30_000
        full_body_h = measure_text_height(body_s, inner_w, body_size, line_spacing=1.2) if body_s else 0
        needed = 2 * pad + title_h + full_body_h + 30_000
        # Short client phrases must stay complete; height estimator is conservative and
        # otherwise collapses actions like «Исключить из digital profile…» to one word.
        short_phrase = bool(body_s) and len(body_s) <= 110 and len(body_s.split()) <= 16
        if body_s and needed > budget and not short_phrase:
            body_budget = max(100_000, budget - 2 * pad - title_h)
            # PDF-36 D.3 — step the font down (−1/−2 pt, min 9pt) before any
            # text is dropped: +20–30% capacity, imperceptible to the eye.
            for candidate in (body_size - 1, body_size - 2, 9):
                if candidate < 9:
                    break
                if measure_text_height(body_s, inner_w, candidate, line_spacing=1.2) <= body_budget:
                    body_size = candidate
                    break
            else:
                body_size = max(9, body_size - 2)
            body_h = measure_text_height(body_s, inner_w, body_size, line_spacing=1.2)
            if body_h > body_budget:
                # Prefer dropping whole structural lines over mid-phrase clips.
                if "\n" in body_s:
                    kept_lines: list[str] = []
                    for ln in body_s.split("\n"):
                        trial = "\n".join(kept_lines + [ln]) if kept_lines else ln
                        if measure_text_height(trial, inner_w, body_size, line_spacing=1.2) <= body_budget:
                            kept_lines.append(ln)
                        else:
                            break
                    body_s = "\n".join(kept_lines) if kept_lines else body_s.split("\n")[0]
                else:
                    body_s = _fit_text_to_height(body_s, inner_w, body_size, body_budget)
                body_h = measure_text_height(body_s, inner_w, body_size, line_spacing=1.2) if body_s else 0
        else:
            body_h = full_body_h
        h = max(min_h, min(budget, 2 * pad + title_h + body_h + 30_000))
        self.card(y, h=h, x=x, w=width, fill=fill)
        cy = y + pad
        if title_s:
            box = self.slide.shapes.add_textbox(Emu(x + pad), Emu(cy), Emu(inner_w), Emu(max(title_h, 160_000)))
            tf = box.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            r = p.add_run()
            r.text = title_s
            r.font.name = FONT
            r.font.bold = True
            r.font.size = Pt(title_size)
            r.font.color.rgb = title_color
            cy += title_h
        if body_s:
            rem = max(100_000, y + h - cy - pad)
            box = self.slide.shapes.add_textbox(Emu(x + pad), Emu(cy), Emu(inner_w), Emu(rem))
            tf = box.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            r = p.add_run()
            r.text = body_s
            r.font.name = FONT
            r.font.size = Pt(body_size)
            r.font.color.rgb = BODY_COLOR
        return y + h

    def metric_chips(self, metrics: list[dict[str, Any]], x: int, y: int, width: int) -> int:
        """Render 2-column metric chips; return bottom Y."""
        items = [m for m in metrics if isinstance(m, dict) and _safe(m.get("value"))][:4]
        if not items:
            return y
        cols = 2
        gap = 70_000
        chip_w = (width - gap) // cols
        chip_h = 640_000
        row_y = y
        for idx, m in enumerate(items):
            col = idx % cols
            if idx > 0 and col == 0:
                row_y += chip_h + gap
            cx = x + col * (chip_w + gap)
            tone = str(m.get("tone") or "neutral")
            fill = {"risk": RISK_BG, "warn": WARN_BG, "good": GOOD_BG}.get(tone, CARD_BG)
            value_color = {"risk": TONE_RISK, "warn": TONE_WARN, "good": TONE_GOOD}.get(tone, NAVY)
            value = _clip_words(_safe(m.get("value")), 36)
            label = _clip_words(_safe(m.get("label")), 28)
            self.card(row_y, h=chip_h, x=cx, w=chip_w, fill=fill)
            box = self.slide.shapes.add_textbox(
                Emu(cx + 50_000), Emu(row_y + 70_000), Emu(chip_w - 100_000), Emu(chip_h - 140_000)
            )
            tf = box.text_frame
            tf.word_wrap = True
            p0 = tf.paragraphs[0]
            r0 = p0.add_run()
            r0.text = value
            r0.font.name = FONT
            r0.font.bold = True
            r0.font.size = Pt(14 if len(value) > 12 else 16)
            r0.font.color.rgb = value_color
            p1 = tf.add_paragraph()
            p1.space_before = Pt(4)
            r1 = p1.add_run()
            r1.text = label
            r1.font.name = FONT
            r1.font.size = Pt(9)
            r1.font.color.rgb = MUTED_COLOR
        rows = (len(items) + cols - 1) // cols
        return y + rows * chip_h + max(0, rows - 1) * gap

    def bullets(self, items: list[str], y: int, color: RGBColor = BODY_COLOR, max_items: int = 8, max_chars: int = 900) -> int:
        dangling = re.compile(
            r"(?:\bв\s+т\.?\s*ч\.?|\bс\s+[А-ЯA-Z]\.?|\b[А-ЯA-Z]\.?|,|;|—|–|-|\()\s*$",
            re.I,
        )
        kept: list[str] = []
        for b in items[:max_items]:
            raw = _safe(b)
            if not raw:
                continue
            clipped = _clip_structured_bullet(raw, max_chars)
            # Drop incomplete trailing parentheticals from mid-clip
            # (e.g. «…спорах (в.» from «(в т.ч. материалы на …)»).
            clipped = re.sub(r"\s*\([^)\n]*$", "", clipped).rstrip(" :;")
            flat_tail = clipped.replace("\n", " ").rstrip()
            if dangling.search(flat_tail):
                punct = max(clipped.rfind(". "), clipped.rfind("! "), clipped.rfind("? "))
                if punct > 40:
                    clipped = clipped[: punct + 1].strip()
                else:
                    clipped = _trim_dangling_tail(clipped)
                clipped = re.sub(r"\s*\([^)\n]*$", "", clipped).rstrip(" :;")
            flat_tail = clipped.replace("\n", " ").rstrip()
            if dangling.search(flat_tail) or flat_tail.endswith(("—", "–", "-", "(")):
                # Prefer dropping the broken last structural line over failing render.
                lines = [ln.strip() for ln in clipped.split("\n") if ln.strip()]
                while lines and (
                    dangling.search(lines[-1])
                    or lines[-1].endswith(("—", "–", "-", "("))
                    or "(" in lines[-1] and ")" not in lines[-1]
                ):
                    lines.pop()
                clipped = "\n".join(lines).strip()
                flat_tail = clipped.replace("\n", " ").rstrip()
            if not clipped:
                continue
            if dangling.search(flat_tail) or flat_tail.endswith(("—", "–", "-", "(")):
                raise RuntimeError(f"ORION bullet dangling on p{self.page}: {flat_tail[-48:]}")
            kept.append(clipped)
        if not kept:
            return y
        # PDF-46 I.2 — whole bullets only; inflate measure (estimator is short
        # on multi-line theme cards) and never paint past CONTENT_BOTTOM.
        page_avail = max(0, CONTENT_BOTTOM - y - 120_000)
        measure_slack = 1.18

        def _bullet_block_height(blocks: list[str]) -> int:
            trial_lines: list[str] = []
            for b in blocks:
                parts = _split_structured_bullet(b) or [b]
                trial_lines.append(f"• {parts[0]}")
                trial_lines.extend(f"   {p}" for p in parts[1:])
            trial = "\n".join(trial_lines)
            raw_h = measure_text_height(
                trial, CONTENT_W, FS_BODY, line_spacing=1.2, paragraph_spacing_pt=6
            )
            return int(raw_h * measure_slack) + 60_000

        while kept and _bullet_block_height(kept) > page_avail:
            if len(kept) == 1:
                # Drop whole structural lines from the sole bullet until it fits.
                parts = _split_structured_bullet(kept[0]) or [kept[0]]
                while len(parts) > 1 and _bullet_block_height(["\n".join(parts)]) > page_avail:
                    parts.pop()
                kept = ["\n".join(parts)] if parts and _bullet_block_height(["\n".join(parts)]) <= page_avail else []
                break
            kept.pop()
        if not kept:
            return y
        text_lines: list[str] = []
        for b in kept:
            parts = _split_structured_bullet(b) or [b]
            text_lines.append(f"• {parts[0]}")
            text_lines.extend(f"   {p}" for p in parts[1:])
        text = "\n".join(text_lines)
        needed = _bullet_block_height(kept)
        avail = max(200_000, min(needed, page_avail))
        # Hard cap: textbox bottom must stay at/above CONTENT_BOTTOM.
        if y + avail > CONTENT_BOTTOM:
            avail = max(0, CONTENT_BOTTOM - y)
        if avail < 200_000:
            return y
        box = self.slide.shapes.add_textbox(Emu(MARGIN_X), Emu(y), Emu(CONTENT_W), Emu(avail))
        tf = box.text_frame
        tf.word_wrap = True
        first_para = True
        for bullet in kept:
            lines = _split_structured_bullet(bullet) or [bullet]
            for li, line in enumerate(lines):
                p = tf.paragraphs[0] if first_para else tf.add_paragraph()
                first_para = False
                p.space_before = Pt(6 if li == 0 else 1)
                p.space_after = Pt(6 if li == len(lines) - 1 else 1)
                p.line_spacing = 1.12
                bold, line_color, size_pt = _bullet_line_style(line, is_first=(li == 0))
                # Fallback color arg only for flat single-line bullets.
                if len(lines) == 1 and color != BODY_COLOR:
                    line_color = color
                r = p.add_run()
                r.text = f"• {line}" if li == 0 else f"   {line}"
                r.font.name = FONT
                r.font.bold = bold
                r.font.size = Pt(size_pt)
                r.font.color.rgb = line_color
        return y + min(avail, needed + 60_000)


def _asset_map(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(a.get("assetRef")): a for a in payload.get("assets") or []}


def _resolve_image_bytes(asset: dict[str, Any] | None) -> bytes | None:
    """Load PNG/JPEG bytes from inline imageData or DATA_ROOT storageKey."""
    if not asset:
        return None
    img_data = asset.get("imageData")
    if img_data:
        try:
            raw = base64.b64decode(str(img_data))
            if len(raw) > 500:
                return raw
        except Exception:  # noqa: BLE001
            pass
    storage_key = str(asset.get("storageKey") or "").strip().lstrip("/")
    if storage_key:
        data_root = Path(os.environ.get("DATA_ROOT", "/data"))
        # storage keys are relative to digital-profile root; DATA_ROOT usually mounts that root.
        candidates = [
            data_root / storage_key,
            data_root / "digital-profile" / storage_key,
            Path(storage_key),
        ]
        for path in candidates:
            try:
                if path.is_file() and path.stat().st_size > 500:
                    return path.read_bytes()
            except OSError:
                continue
    return None


def _embed_image_contain(ctx: _Ctx, asset: dict[str, Any] | None, y: int, h: int = 4800000) -> bool:
    """Place image inside (MARGIN_X, y, CONTENT_W, h) preserving aspect ratio."""
    if not asset:
        ctx.body("Визуальный материал недоступен для данного раздела.", y)
        return False
    raw = _resolve_image_bytes(asset)
    if not raw:
        title = _safe(asset.get("title") or "Источник")
        domain = _safe(asset.get("caption") or asset.get("storageKey") or "")
        ctx.card(y, h)
        ctx.body(
            f"{title}\n{domain}\nИзображение недоступно — показаны источник и описание.",
            y + 120000,
            max_h=h - 200000,
        )
        return False
    box_w, box_h = CONTENT_W, h
    iw, ih = box_w, box_h
    if Image is not None:
        try:
            with Image.open(io.BytesIO(raw)) as im:
                iw, ih = im.size
        except Exception:  # noqa: BLE001
            pass
    scale = min(box_w / max(iw, 1), box_h / max(ih, 1))
    draw_w = int(iw * scale)
    draw_h = int(ih * scale)
    left = MARGIN_X + (box_w - draw_w) // 2
    top = y + (box_h - draw_h) // 2
    stream = io.BytesIO(raw)
    ctx.slide.shapes.add_picture(stream, Emu(left), Emu(top), width=Emu(draw_w), height=Emu(draw_h))
    return True


def _embed_image(ctx: _Ctx, asset: dict[str, Any] | None, y: int, h: int = 4800000) -> None:
    _embed_image_contain(ctx, asset, y, h)


def _first_visual_asset(refs: list[Any], assets: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    for ref in refs:
        asset = assets.get(str(ref))
        if asset and _resolve_image_bytes(asset):
            return asset
    return None


