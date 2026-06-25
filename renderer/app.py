"""Digital Profile report renderer service.

A small, isolated HTTP service that turns a `report_json` into a PPTX (via
python-pptx) and a PDF (via headless LibreOffice). It writes both files into the
SHARED private storage volume (mounted at DATA_ROOT) using the storage keys
provided by the caller, then returns each file's size + SHA-256.

The Node app calls this service; the files land in the same private storage the
Node app serves via signed URLs. No file is ever exposed publicly here.
"""

from __future__ import annotations

import hashlib
import os
import shutil

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from convert_pdf import convert_to_pdf
from render_pptx import build_pptx
from report_i18n import normalize_lang

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


class RenderResponse(BaseModel):
    pptx: FileInfo
    pdf: FileInfo
    templateVersion: str
    slideCount: int = 0
    audience: str = "internal"
    watermarkMode: str = "draft"
    reportLanguage: str = "ru"
    warnings: list[str] = []


def _safe_path(key: str) -> str:
    full = os.path.realpath(os.path.join(DATA_ROOT, key))
    root = os.path.realpath(DATA_ROOT)
    if full != root and not full.startswith(root + os.sep):
        raise HTTPException(status_code=400, detail="Invalid storage key")
    return full


def _file_info(key: str, path: str) -> FileInfo:
    with open(path, "rb") as fh:
        data = fh.read()
    return FileInfo(
        storageKey=key,
        sizeBytes=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
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


DEFAULT_TEMPLATE_VERSION = "report-template-v1"


@app.post("/render", response_model=RenderResponse)
def render(req: RenderRequest) -> RenderResponse:
    pptx_path = _safe_path(req.pptxKey)
    pdf_path = _safe_path(req.pdfKey)
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

    return RenderResponse(
        pptx=_file_info(req.pptxKey, pptx_path),
        pdf=_file_info(req.pdfKey, pdf_path),
        templateVersion=version,
        slideCount=slide_count,
        audience=audience,
        watermarkMode=watermark_mode,
        reportLanguage=report_language,
        warnings=warnings or [],
    )
