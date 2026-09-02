"""ORION Golden renderer package (REMEDIATION §9.5)."""

from .api import BULLET_MEASURE_VERSION, measure_orion_golden, render_orion_golden
from .common import (
    SIDEBAR_SAFE_FALLBACK,
    assert_render_font_family,
    get_bullet_measure,
    get_layout_telemetry,
    reset_bullet_measure,
    reset_layout_telemetry,
)

__all__ = [
    "BULLET_MEASURE_VERSION",
    "measure_orion_golden",
    "render_orion_golden",
    "SIDEBAR_SAFE_FALLBACK",
    "assert_render_font_family",
    "get_bullet_measure",
    "get_layout_telemetry",
    "reset_bullet_measure",
    "reset_layout_telemetry",
]
