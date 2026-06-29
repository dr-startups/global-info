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

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from convert_pdf import convert_to_pdf
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


DEFAULT_TEMPLATE_VERSION = "report-template-v3"


@app.post("/render", response_model=RenderResponse)
def render(req: RenderRequest) -> RenderResponse:
    version = (req.templateVersion or DEFAULT_TEMPLATE_VERSION).strip()
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
