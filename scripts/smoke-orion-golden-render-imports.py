#!/usr/bin/env python3
"""Catch missing imports after orion_golden_render §9.5 split.

1) Static Name/import audit of package modules (always).
2) Render executive/risk/overview templates when DejaVu font is available
   (or ORION_SMOKE_FORCE_RENDER=1 with a patched font assert).

Run: python scripts/smoke-orion-golden-render-imports.py
"""

from __future__ import annotations

import ast
import builtins
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PKG = ROOT / "renderer" / "orion_golden_render"
sys.path.insert(0, str(ROOT / "renderer"))

from smoke_counters import print_tap_counters  # noqa: E402


def _audit_imports() -> list[str]:
    builtin = set(dir(builtins))
    problems: list[str] = []
    for path in sorted(PKG.glob("*.py")):
        if path.name == "__init__.py":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        imported: set[str] = set()
        defined: set[str] = set()
        assigned: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defined.add(node.name)
            if isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    imported.add(alias.asname or alias.name)
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imported.add((alias.asname or alias.name).split(".")[0])
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        assigned.add(target.id)
            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                assigned.add(node.target.id)
        used: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                used.add(node.id)
        skip = builtin | imported | defined | assigned | {"annotations", "__file__"}
        interesting = sorted(
            n
            for n in used
            if n not in skip
            and (
                n[:1].isupper()
                or n.startswith("_")
                or n
                in {
                    "io",
                    "re",
                    "json",
                    "os",
                    "base64",
                    "fitz",
                    "measure_text_height",
                    "record_text_layout",
                }
            )
        )
        for name in interesting:
            problems.append(f"{path.name}:{name}")
    return problems


def _try_render() -> str:
    from orion_golden_render.common import _font_path, assert_render_font_family
    from orion_golden_renderer import render_orion_golden

    force = os.environ.get("ORION_SMOKE_FORCE_RENDER") == "1"
    if not _font_path() and not force:
        return "skipped(no-dejavu-font)"

    if force and not _font_path():
        # Local Windows without DejaVu: still exercise template dispatch.
        import orion_golden_render.api as api

        api.assert_render_font_family = lambda: "DejaVu Sans"  # type: ignore[assignment]
    else:
        assert_render_font_family()

    payload = {
        "reportSpec": {"subject": {"displayName": "Тестов Иван"}},
        "deckManifest": {
            "finalSlides": [
                {
                    "template": "orion_golden_executive_dashboard",
                    "title": "Краткий вывод",
                    "narrative": (
                        "Субъект присутствует в открытых источниках. "
                        "Ключевые риски требуют ручной проверки."
                    ),
                    "metrics": [
                        {"label": "RU", "value": "12"},
                        {"label": "UAE", "value": "3"},
                    ],
                    "findings": [
                        {
                            "headline": "Санкционный контур",
                            "detail": "Упоминания требуют сверки с первоисточником.",
                            "status": "warn",
                        }
                    ],
                    "recommendedActions": [{"label": "Сверить карточку вручную"}],
                },
                {
                    "template": "orion_golden_risk_matrix",
                    "title": "Матрица рисков",
                    "findings": [
                        {
                            "headline": "Тема A",
                            "detail": "Короткое описание риска для сетки.",
                            "status": "risk",
                            "severity": "high",
                        }
                    ],
                },
                {
                    "template": "orion_golden_profile_overview",
                    "title": "Обзор профиля",
                    "metrics": [
                        {"label": "Россия", "value": "10"},
                        {"label": "ОАЭ", "value": "2"},
                    ],
                    "findings": [
                        {
                            "headline": "Идентичность",
                            "detail": "Профиль собран по открытым источникам.",
                        }
                    ],
                },
            ]
        },
        "assets": [],
    }
    out = render_orion_golden(payload)
    assert out.get("pptxBase64") or out.get("pdfBase64"), list(out.keys())
    return "rendered"


def main() -> int:
    # Счётчик выполненных проверок: раннер держит правило «прогон без единой
    # проверки — провал» на TAP-счётчиках, а без них смок этому правилу
    # неподотчётен и «ок» ничего не доказывает.
    done = 0

    problems = _audit_imports()
    assert not problems, "missing imports after §9.5 split:\n  " + "\n  ".join(problems)
    done += 1

    mode = "skipped(no-renderer-deps)"
    try:
        import pptx  # noqa: F401
    except ImportError:
        # `# SKIP` — общий формат для сводки раннера (scripts/run-smokes.ts):
        # пропуск обязан быть виден в конце прогона, а не только здесь.
        print("# SKIP отрисовка шаблонов — не установлен python-pptx")
        print(
            f"smoke-orion-golden-render-imports: ok audit={len(list(PKG.glob('*.py')))} render={mode}"
        )
        print_tap_counters(passed=done, failed=0, skipped=1)
        return 0

    # With python-pptx present, also import modules and optionally render.
    from orion_golden_render.executive import _render_executive_dashboard  # noqa: F401
    from orion_golden_render.slides import _render_slide  # noqa: F401
    from orion_golden_render.visual import _render_visual_with_sidebar  # noqa: F401

    done += 1  # модули шаблонов импортируются

    mode = _try_render()
    skipped = 0
    if mode.startswith("skipped"):
        print(f"# SKIP отрисовка шаблонов — {mode}")
        skipped = 1
    else:
        done += 1  # дека действительно отрисована
    print(f"smoke-orion-golden-render-imports: ok audit={len(list(PKG.glob('*.py')))} render={mode}")
    print_tap_counters(passed=done, failed=0, skipped=skipped)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
