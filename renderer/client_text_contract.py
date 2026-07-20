"""REMEDIATION §6.1 — shared client-text contract for ORION Golden renderer.

Reads the same JSON as the TypeScript loader. Prefer the contract embedded in
the render payload; fall back to the sibling JSON shipped with the renderer.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

_DEFAULT_PATH = Path(__file__).with_name("client_text_contract.json")

REQUIRED_KEYS = (
    "version",
    "forbiddenRawTokens",
    "allowedSnakeTokens",
    "internalTokenPattern",
    "fieldBudgets",
    "sidebarBannedPattern",
    "sidebarEllipsisForbidden",
    "rawCaseIdPattern",
    "rendererStripPattern",
)


def _validate(contract: dict[str, Any]) -> dict[str, Any]:
    for key in REQUIRED_KEYS:
        if key not in contract:
            raise ValueError(f"client-text-contract missing key: {key}")
    if not isinstance(contract["forbiddenRawTokens"], list) or not contract["forbiddenRawTokens"]:
        raise ValueError("forbiddenRawTokens must be a non-empty list")
    budgets = contract["fieldBudgets"]
    for field in ("title", "narrative", "bullet", "whatWasFound", "whyItMatters", "whatToCheck"):
        if field not in budgets:
            raise ValueError(f"fieldBudgets missing {field}")
    return contract


@lru_cache(maxsize=1)
def load_bundled_contract() -> dict[str, Any]:
    raw = json.loads(_DEFAULT_PATH.read_text(encoding="utf-8"))
    return _validate(raw)


def resolve_contract(raw: Any | None = None) -> dict[str, Any]:
    if raw is None:
        return load_bundled_contract()
    if not isinstance(raw, dict):
        raise ValueError("clientTextContract must be an object")
    return _validate(raw)


def evaluate_client_text(
    text: str,
    *,
    surface: str = "body",
    contract: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Parity with TS evaluateClientText — same codes for the same input."""
    c = resolve_contract(contract)
    value = str(text or "")
    issues: list[dict[str, str]] = []

    if surface == "sidebar":
        if c.get("sidebarEllipsisForbidden") and ("…" in value or "..." in value):
            issues.append({"code": "sidebar-ellipsis"})
        banned = re.compile(str(c["sidebarBannedPattern"]), re.I)
        m = banned.search(value)
        if m:
            issues.append({"code": "sidebar-forbidden", "detail": m.group(0)})
    else:
        lower = value.lower()
        for token in c["forbiddenRawTokens"]:
            if str(token).lower() in lower:
                issues.append({"code": "forbidden", "detail": str(token)})
        internal = re.compile(str(c["internalTokenPattern"]), re.I | re.U)
        if internal.search(value):
            issues.append({"code": "internal-token"})
        raw_case = re.compile(str(c["rawCaseIdPattern"]), re.I)
        if raw_case.search(value):
            issues.append({"code": "forbidden", "detail": "raw-case-id"})

    return {
        "ok": len(issues) == 0,
        "issues": issues,
        "contractVersion": c["version"],
    }


def renderer_strip_re(contract: dict[str, Any] | None = None) -> re.Pattern[str]:
    c = resolve_contract(contract)
    return re.compile(str(c["rendererStripPattern"]), re.I)


def sidebar_check_failures(text: str, field: str, contract: dict[str, Any]) -> list[str]:
    """Renderer-facing messages matching the previous QA fail() shape."""
    verdict = evaluate_client_text(text, surface="sidebar", contract=contract)
    out: list[str] = []
    for issue in verdict["issues"]:
        code = issue.get("code")
        if code == "sidebar-ellipsis":
            out.append(f'sidebar ellipsis in {field}')
        elif code == "sidebar-forbidden":
            detail = issue.get("detail") or "?"
            out.append(f'sidebar forbidden token "{detail}" in {field}')
        else:
            out.append(f"sidebar {code} in {field}")
    return out
