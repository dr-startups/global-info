"""ORION Golden renderer package (REMEDIATION §9.5)."""

from .api import render_orion_golden
from .common import (
    SIDEBAR_SAFE_FALLBACK,
    assert_render_font_family,
    get_layout_telemetry,
    reset_layout_telemetry,
)

__all__ = [
    "render_orion_golden",
    "SIDEBAR_SAFE_FALLBACK",
    "assert_render_font_family",
    "get_layout_telemetry",
    "reset_layout_telemetry",
]
