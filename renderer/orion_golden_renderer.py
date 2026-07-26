"""Compatibility shim — implementation in orion_golden_render/ (REMEDIATION §9.5)."""

from __future__ import annotations

try:
    from orion_golden_render import *  # noqa: F403
    from orion_golden_render import __all__ as __all__  # noqa: F401
except ImportError:  # pragma: no cover — package-style import inside container
    from renderer.orion_golden_render import *  # type: ignore  # noqa: F403
    from renderer.orion_golden_render import __all__ as __all__  # type: ignore  # noqa: F401
