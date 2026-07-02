"""Alias entrypoint for O5.4.1 PPTX inspect (slide 13 ORION frame QA)."""
from __future__ import annotations

import runpy
import sys
from pathlib import Path

if __name__ == "__main__":
    target = Path(__file__).with_name("inspect-o541-pptx.py")
    sys.argv[0] = str(target)
    runpy.run_path(str(target), run_name="__main__")
