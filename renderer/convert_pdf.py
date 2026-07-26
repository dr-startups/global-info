"""Convert a PPTX to PDF using headless LibreOffice (soffice) or PowerPoint COM."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path


def _soffice_bin() -> str | None:
    for name in ("soffice", "libreoffice"):
        path = shutil.which(name)
        if path:
            return path
    for candidate in (
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    ):
        if Path(candidate).is_file():
            return candidate
    return None


def _convert_with_powerpoint(pptx_path: str, pdf_path: str) -> None:
    """Windows fallback: PowerPoint COM SaveAs PDF (ppSaveAsPDF = 32)."""
    try:
        import win32com.client  # type: ignore
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("pywin32 not available for PowerPoint PDF export") from exc

    pptx_abs = str(Path(pptx_path).resolve())
    pdf_abs = str(Path(pdf_path).resolve())
    os.makedirs(os.path.dirname(pdf_abs) or ".", exist_ok=True)
    app = win32com.client.Dispatch("PowerPoint.Application")
    try:
        # 0 = msoFalse for WithWindow when supported
        try:
            app.Visible = 0
        except Exception:  # noqa: BLE001
            pass
        pres = app.Presentations.Open(pptx_abs, WithWindow=False)
        try:
            pres.SaveAs(pdf_abs, 32)
        finally:
            pres.Close()
    finally:
        app.Quit()
    if not Path(pdf_abs).is_file() or Path(pdf_abs).stat().st_size < 1000:
        raise RuntimeError("PowerPoint PDF export produced no file")


def convert_to_pdf(pptx_path: str, pdf_path: str, timeout: int = 120) -> None:
    """Convert pptx_path -> pdf_path. Prefer LibreOffice; fall back to PowerPoint on Windows."""
    os.makedirs(os.path.dirname(pdf_path) or ".", exist_ok=True)
    soffice = _soffice_bin()
    if soffice:
        with tempfile.TemporaryDirectory() as tmp:
            profile = os.path.join(tmp, "profile")
            cmd = [
                soffice,
                f"-env:UserInstallation=file://{profile}",
                "--headless",
                "--norestore",
                "--convert-to",
                "pdf",
                "--outdir",
                tmp,
                pptx_path,
            ]
            proc = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                check=False,
            )
            base = os.path.splitext(os.path.basename(pptx_path))[0] + ".pdf"
            produced = os.path.join(tmp, base)
            if os.path.exists(produced):
                shutil.move(produced, pdf_path)
                return
            lo_err = proc.stderr.decode("utf-8", "ignore") or "no output"
        # fall through to PowerPoint if LO failed
        lo_failed = lo_err
    else:
        lo_failed = "LibreOffice (soffice) not found"

    if os.name == "nt":
        try:
            _convert_with_powerpoint(pptx_path, pdf_path)
            return
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"PDF conversion failed (LO: {lo_failed}; PPT: {exc})") from exc

    raise RuntimeError(f"PDF conversion failed: {lo_failed}")
