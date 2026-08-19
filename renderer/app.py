"""Digital Profile report renderer service.

A small, STATELESS HTTP service that turns a `report_json` into a PPTX (via
python-pptx) and a PDF (via headless LibreOffice). It renders into a temporary
directory, returns each file's bytes (base64) + size + SHA-256, then deletes the
temp dir. The Node app receives the bytes and persists them through its storage
provider — the renderer never depends on a persistent/shared volume and never
exposes any file publicly.

DATA_ROOT (optional) is used only as a read-only base to resolve input images
(e.g. screenshots) referenced by report_json. When it is absent (e.g. a split
Railway deployment) missing images are skipped gracefully.
"""

from __future__ import annotations

import base64
import hashlib
import os
import shutil
import tempfile
import threading

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from convert_pdf import convert_to_pdf
from lexis_docx import process_lexis_docx_bytes
from orion_golden_renderer import measure_orion_golden, render_orion_golden
from orion_manifest_render import render_orion_manifest
from orion_report_spec_render import render_report_spec
from orion_visual_composer import render_client_storyboard
from render_pptx import build_pptx
from report_i18n import normalize_lang

# Read-only base for input images only; outputs are never written here.
DATA_ROOT = os.environ.get("DATA_ROOT", "/data")
SERVICE_NAME = "digital-profile-renderer"
SERVICE_VERSION = "1.0.0"

app = FastAPI(title="Digital Profile Renderer", version=SERVICE_VERSION)


def _libreoffice_available() -> bool:
    return any(shutil.which(name) for name in ("soffice", "libreoffice"))


class RenderRequest(BaseModel):
    reportJson: dict
    pptxKey: str
    pdfKey: str
    templateVersion: str | None = None
    audience: str | None = None
    watermarkMode: str | None = None
    reportLanguage: str | None = None


class FileInfo(BaseModel):
    storageKey: str
    sizeBytes: int
    sha256: str
    # Base64-encoded file bytes returned over HTTP so the caller (Node) can
    # persist them via its own storage provider (no shared volume needed).
    contentBase64: str


class RenderResponse(BaseModel):
    pptx: FileInfo
    pdf: FileInfo
    templateVersion: str
    slideCount: int = 0
    audience: str = "internal"
    watermarkMode: str = "draft"
    reportLanguage: str = "ru"
    warnings: list[str] = []


class LexisDocxPage(BaseModel):
    pageNumber: int
    width: int
    height: int
    contentBase64: str


class LexisDocxProcessRequest(BaseModel):
    docxBase64: str


class LexisDocxProcessResponse(BaseModel):
    text: str
    pages: list[LexisDocxPage]
    parserWarnings: list[str] = []
    conversionWarnings: list[str] = []


class OrionManifestRenderRequest(BaseModel):
    reportJson: dict
    audience: str | None = "internal"


class OrionManifestPage(BaseModel):
    pageNumber: int
    width: int
    height: int
    contentBase64: str


class OrionManifestRenderResponse(BaseModel):
    slideCount: int
    pptxBase64: str
    pdfBase64: str
    pages: list[OrionManifestPage]
    pdfExportMode: str | None = None
    warnings: list[str] = []
    # Layout telemetry is part of the contract: without it the caller cannot
    # tell whether the renderer dropped whole blocks off a page. Only
    # /orion/render-golden collects it; the other endpoints sharing this model
    # leave it null rather than inventing an empty "nothing was lost".
    layoutTelemetry: dict | None = None


class OrionReportSpecRenderRequest(BaseModel):
    reportSpec: dict
    audience: str | None = "client"


class OrionClientStoryboardRenderRequest(BaseModel):
    storyboard: dict
    assets: list[dict] = []


class OrionGoldenRenderRequest(BaseModel):
    reportSpec: dict
    deckManifest: dict
    assets: list[dict] = []


class OrionBulletMeasureResponse(BaseModel):
    """Вердикт мерного прогона: сколько высоты под список и сколько просит каждый блок."""

    version: str
    pages: list[dict] = []


def _file_info(key: str, path: str) -> FileInfo:
    with open(path, "rb") as fh:
        data = fh.read()
    return FileInfo(
        storageKey=key,
        sizeBytes=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        contentBase64=base64.b64encode(data).decode("ascii"),
    )


@app.get("/health")
def health() -> dict:
    lo_ok = _libreoffice_available()
    return {
        "ok": lo_ok,
        "service": SERVICE_NAME,
        "libreOfficeAvailable": lo_ok,
        "version": SERVICE_VERSION,
    }


DEFAULT_TEMPLATE_VERSION = "simple"


@app.post("/orion/render-manifest", response_model=OrionManifestRenderResponse)
def orion_render_manifest(req: OrionManifestRenderRequest) -> OrionManifestRenderResponse:
    """Render ORION v2 manifest JSON into PPTX/PDF/PNG pages."""
    audience = (req.audience or "internal").strip().lower()
    if audience not in {"internal", "client"}:
        raise HTTPException(status_code=400, detail="audience must be internal or client")
    try:
        result = render_orion_manifest(req.reportJson, audience=audience)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"ORION manifest render failed: {exc}") from exc
    return OrionManifestRenderResponse(
        slideCount=int(result.get("slideCount") or 0),
        pptxBase64=str(result.get("pptxBase64") or ""),
        pdfBase64=str(result.get("pdfBase64") or ""),
        pages=[OrionManifestPage(**page) for page in result.get("pages") or []],
        pdfExportMode=str(result.get("pdfExportMode") or "unknown"),
        warnings=list(result.get("warnings") or []),
    )


@app.post("/orion/render-client-storyboard", response_model=OrionManifestRenderResponse)
def orion_render_client_storyboard(req: OrionClientStoryboardRenderRequest) -> OrionManifestRenderResponse:
    """Render ORION ClientStoryboard v1 into PPTX/PDF/PNG pages (R9.9)."""
    try:
        payload = {"storyboard": req.storyboard, "assets": req.assets}
        result = render_client_storyboard(payload)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"ORION client storyboard render failed: {exc}") from exc
    return OrionManifestRenderResponse(
        slideCount=int(result.get("slideCount") or 0),
        pptxBase64=str(result.get("pptxBase64") or ""),
        pdfBase64=str(result.get("pdfBase64") or ""),
        pages=[OrionManifestPage(**page) for page in result.get("pages") or []],
        pdfExportMode=str(result.get("pdfExportMode") or "unknown"),
        warnings=list(result.get("warnings") or []),
    )


# Layout telemetry lives in a module-level list of the renderer package, and
# FastAPI runs synchronous endpoints in a thread pool: two concurrent golden
# renders would interleave their entries and each render's reset() would wipe
# what the other had collected. The gate on the caller's side stands on that
# telemetry, so it must belong to exactly one document — renders are serialized.
#
# The trade is deliberate and worth naming: this lock is GLOBAL, not per case,
# because the telemetry list is global. Step leases are per case, so two cases
# do reach ORION_PREPARE at the same time; "the second request waits instead of
# failing" holds only while waiting plus rendering fits the caller's budget
# (300s in postGoldenRender). Past that the caller fails loudly with
# RENDER_FAILED and resumes from its RENDER checkpoint — no silent truncation.
# The `with` block releases the lock even when the render raises.
_GOLDEN_RENDER_LOCK = threading.Lock()


@app.post("/orion/render-golden", response_model=OrionManifestRenderResponse)
def orion_render_golden(req: OrionGoldenRenderRequest) -> OrionManifestRenderResponse:
    """Render ORION Golden ReportSpec + deck manifest into PPTX/PDF/PNG pages (R10)."""
    try:
        payload = {
            "reportSpec": req.reportSpec,
            "deckManifest": req.deckManifest,
            "assets": req.assets,
        }
        with _GOLDEN_RENDER_LOCK:
            result = render_orion_golden(payload)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"ORION Golden render failed: {exc}") from exc
    return OrionManifestRenderResponse(
        slideCount=int(result.get("slideCount") or 0),
        pptxBase64=str(result.get("pptxBase64") or ""),
        pdfBase64=str(result.get("pdfBase64") or ""),
        pages=[OrionManifestPage(**page) for page in result.get("pages") or []],
        pdfExportMode=str(result.get("pdfExportMode") or "unknown"),
        warnings=list(result.get("warnings") or []),
        layoutTelemetry=result.get("layoutTelemetry"),
    )


@app.post("/orion/measure-layout", response_model=OrionBulletMeasureResponse)
def orion_measure_layout(req: OrionGoldenRenderRequest) -> OrionBulletMeasureResponse:
    """Мерный прогон деки: тот же код рисования, без файлов и без экспорта.

    Отвечает на единственный вопрос, на который у проекта было три ответа: что
    из поданного помещается на лист. Построитель раскладывает блоки по этому
    вердикту и пересобирает деку до чистой меры, а настоящий рендер потом судят
    прежние ворота. Мера идёт под тем же локом, что и рендер: телеметрия и
    сборник мерных записей — модульные списки процесса, и два одновременных
    прогона перемешали бы их.
    """
    try:
        payload = {
            "reportSpec": req.reportSpec,
            "deckManifest": req.deckManifest,
            "assets": req.assets,
        }
        with _GOLDEN_RENDER_LOCK:
            result = measure_orion_golden(payload)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"ORION Golden measure failed: {exc}") from exc
    return OrionBulletMeasureResponse(
        version=str(result.get("version") or ""),
        pages=list(result.get("pages") or []),
    )


@app.post("/orion/render-report-spec", response_model=OrionManifestRenderResponse)
def orion_render_report_spec(req: OrionReportSpecRenderRequest) -> OrionManifestRenderResponse:
    """Render ORION ReportSpec v1 JSON into PPTX/PDF/PNG pages."""
    audience = (req.audience or "client").strip().lower()
    if audience not in {"internal", "client"}:
        raise HTTPException(status_code=400, detail="audience must be internal or client")
    try:
        result = render_report_spec(req.reportSpec)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"ORION ReportSpec render failed: {exc}") from exc
    return OrionManifestRenderResponse(
        slideCount=int(result.get("slideCount") or 0),
        pptxBase64=str(result.get("pptxBase64") or ""),
        pdfBase64=str(result.get("pdfBase64") or ""),
        pages=[OrionManifestPage(**page) for page in result.get("pages") or []],
        pdfExportMode=str(result.get("pdfExportMode") or "unknown"),
        warnings=list(result.get("warnings") or []),
    )


@app.post("/lexis/process-docx", response_model=LexisDocxProcessResponse)
def lexis_process_docx(req: LexisDocxProcessRequest) -> LexisDocxProcessResponse:
    """Extract text and render visual PNG pages from a LexisNexis DOCX upload."""
    try:
        docx_bytes = base64.b64decode(req.docxBase64)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Invalid docxBase64: {exc}") from exc
    if not docx_bytes:
        raise HTTPException(status_code=400, detail="Empty DOCX payload")
    try:
        result = process_lexis_docx_bytes(docx_bytes)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Lexis DOCX processing failed: {exc}") from exc
    return LexisDocxProcessResponse(
        text=str(result.get("text") or ""),
        pages=[LexisDocxPage(**page) for page in result.get("pages") or []],
        parserWarnings=list(result.get("parserWarnings") or []),
        conversionWarnings=list(result.get("conversionWarnings") or []),
    )


@app.post("/render", response_model=RenderResponse)
def render(req: RenderRequest) -> RenderResponse:
    """Legacy report_json → PPTX/PDF.

    REMEDIATION 9.3: report_template_v1/v2/v3 are retired. Only template_version
    "simple" remains; new production decks use /orion/render-golden.
    """
    version = (req.templateVersion or DEFAULT_TEMPLATE_VERSION).strip()
    if version.startswith("report-template-v"):
        raise HTTPException(
            status_code=410,
            detail=(
                f"Legacy template {version!r} is retired (REMEDIATION 9.3). "
                "Use /orion/render-golden for ORION Golden decks."
            ),
        )
    audience = (req.audience or "internal").strip().lower()
    watermark_mode = (req.watermarkMode or "draft").strip().lower()

    # Report language: explicit request wins, else what report_json already carries.
    report_json = req.reportJson
    embedded_lang = report_json.get("reportLanguage") or (
        report_json.get("meta", {}) or {}
    ).get("language")
    report_language = normalize_lang(req.reportLanguage or embedded_lang)
    report_json["reportLanguage"] = report_language
    meta = report_json.get("meta")
    if isinstance(meta, dict):
        meta["language"] = report_language

    # Render into a throwaway temp dir; the bytes are returned over HTTP and the
    # temp dir is removed on exit, so no persistent/shared volume is required.
    with tempfile.TemporaryDirectory(prefix="dp-render-") as tmp:
        pptx_path = os.path.join(tmp, "report.pptx")
        pdf_path = os.path.join(tmp, "report.pdf")

        try:
            warnings, slide_count = build_pptx(
                report_json, pptx_path, DATA_ROOT, version, audience, watermark_mode
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"PPTX build failed: {exc}")

        try:
            convert_to_pdf(pptx_path, pdf_path)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"PDF conversion failed: {exc}")

        # The caller's keys are echoed back so it can persist under its own keys.
        pptx_info = _file_info(req.pptxKey or "report.pptx", pptx_path)
        pdf_info = _file_info(req.pdfKey or "report.pdf", pdf_path)

    return RenderResponse(
        pptx=pptx_info,
        pdf=pdf_info,
        templateVersion=version,
        slideCount=slide_count,
        audience=audience,
        watermarkMode=watermark_mode,
        reportLanguage=report_language,
        warnings=warnings or [],
    )
