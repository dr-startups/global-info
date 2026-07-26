"""LexisNexis DOCX processing: text extraction + visual page rendering."""

from __future__ import annotations

import base64
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from convert_pdf import _soffice_bin


def extract_docx_text(docx_path: str) -> tuple[str, list[str]]:
    warnings: list[str] = []
    texts: list[str] = []
    try:
        with zipfile.ZipFile(docx_path, "r") as zf:
            for name in ("word/document.xml", "word/header1.xml", "word/footer1.xml"):
                if name not in zf.namelist():
                    continue
                root = ET.fromstring(zf.read(name))
                for node in root.iter():
                    if node.tag.endswith("}t") and node.text:
                        texts.append(node.text)
    except Exception:  # noqa: BLE001
        warnings.append("docx_extract_failed")
    text = re.sub(r"\s+", " ", " ".join(texts)).strip()
    return text, warnings


def convert_docx_to_pdf(docx_path: str, pdf_path: str, timeout: int = 120) -> None:
    soffice = _soffice_bin()
    out_dir = str(Path(pdf_path).parent)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        profile = str(Path(tmp) / "profile")
        cmd = [
            soffice,
            f"-env:UserInstallation=file://{profile}",
            "--headless",
            "--norestore",
            "--convert-to",
            "pdf",
            "--outdir",
            tmp,
            docx_path,
        ]
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        base = Path(docx_path).stem + ".pdf"
        produced = Path(tmp) / base
        if not produced.exists():
            raise RuntimeError(
                "DOCX to PDF conversion failed: "
                + (proc.stderr.decode("utf-8", "ignore") or "no output")
            )
        shutil.move(str(produced), pdf_path)


def render_pdf_pages(pdf_path: str, matrix_scale: float = 1.6) -> list[dict]:
    import fitz  # PyMuPDF

    doc = fitz.open(pdf_path)
    pages: list[dict] = []
    try:
        for i in range(len(doc)):
            pix = doc[i].get_pixmap(matrix=fitz.Matrix(matrix_scale, matrix_scale))
            pages.append(
                {
                    "pageNumber": i + 1,
                    "width": pix.width,
                    "height": pix.height,
                    "contentBase64": base64.b64encode(pix.tobytes("png")).decode("ascii"),
                }
            )
    finally:
        doc.close()
    return pages


def process_lexis_docx_bytes(docx_bytes: bytes) -> dict:
    parser_warnings: list[str] = []
    conversion_warnings: list[str] = []
    with tempfile.TemporaryDirectory(prefix="dp-lexis-") as tmp:
        work = Path(tmp)
        docx_path = work / "source.docx"
        docx_path.write_bytes(docx_bytes)

        text, extract_warnings = extract_docx_text(str(docx_path))
        parser_warnings.extend(extract_warnings)

        pdf_path = work / "source.pdf"
        try:
            convert_docx_to_pdf(str(docx_path), str(pdf_path))
        except Exception as exc:  # noqa: BLE001
            conversion_warnings.append(f"docx_to_pdf_failed:{exc}")
            return {
                "text": text,
                "pages": [],
                "parserWarnings": parser_warnings,
                "conversionWarnings": conversion_warnings,
            }

        try:
            pages = render_pdf_pages(str(pdf_path))
        except Exception as exc:  # noqa: BLE001
            conversion_warnings.append(f"pdf_to_png_failed:{exc}")
            pages = []

        if not pages:
            conversion_warnings.append("no_rendered_pages")

        return {
            "text": text,
            "pages": pages,
            "parserWarnings": parser_warnings,
            "conversionWarnings": conversion_warnings,
        }
