"""Convert a PPTX to PDF using headless LibreOffice (soffice)."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile


def _soffice_bin() -> str:
    for name in ("soffice", "libreoffice"):
        path = shutil.which(name)
        if path:
            return path
    raise RuntimeError("LibreOffice (soffice) not found on PATH")


def convert_to_pdf(pptx_path: str, pdf_path: str, timeout: int = 120) -> None:
    """Convert pptx_path -> pdf_path. LibreOffice writes <basename>.pdf into the
    output dir, so we convert into a temp dir and move the result to pdf_path."""
    soffice = _soffice_bin()
    os.makedirs(os.path.dirname(pdf_path), exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        # A dedicated user profile dir avoids "another instance" locking issues.
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
        if not os.path.exists(produced):
            raise RuntimeError(
                "PDF conversion failed: "
                + (proc.stderr.decode("utf-8", "ignore") or "no output")
            )
        shutil.move(produced, pdf_path)
