#!/usr/bin/env python3
"""Смок: телеметрия разметки доезжает до ответа /orion/render-golden целой.

Живой рендер всегда идёт по HTTP, а модель ответа `OrionManifestRenderResponse`
поля `layoutTelemetry` не имела: `render_orion_golden` записи собирал, FastAPI
их вырезал, и на живом пути потери рендерера были непроверяемы. Здесь
проверяется контракт эндпоинта, а не внутренняя функция: смок зовёт ту же
функцию, что и FastAPI, и смотрит на модель ответа.

Второе свойство — целость доказательства. `_LAYOUT_TELEMETRY` — модульный
список процесса, а синхронные эндпоинты FastAPI исполняются в пуле потоков:
два одновременных рендера перемешают записи, а `reset` одного сотрёт
наработанное другим. Ворота, стоящие на перемешанной телеметрии, судят не тот
документ.

Сеть и база не нужны: эндпоинт вызывается как функция. Нужны Python-пакеты
рендерера (python-pptx, PyMuPDF, fastapi) и LibreOffice для конвертации.

Запуск: python3 renderer/smoke_layout_telemetry_reaches_response.py
"""

from __future__ import annotations

import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from smoke_counters import print_tap_counters  # noqa: E402

import app  # noqa: E402

failures: list[str] = []
passed_checks = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed_checks
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if ok:
        passed_checks += 1
    else:
        failures.append(name)


def deck(slides: int, marker: str) -> app.OrionGoldenRenderRequest:
    """Минимальная дека из текстовых страниц — каждая пишет свою запись."""
    return app.OrionGoldenRenderRequest(
        reportSpec={"subject": {"displayName": f"Субъект {marker}"}},
        deckManifest={
            "finalSlides": [
                {
                    "template": "orion_golden_prose",
                    "title": f"Страница {i} ({marker})",
                    "narrative": f"Проверочный текст страницы {i} деки {marker}.",
                    "pageNumber": i,
                    "totalPageCount": slides,
                }
                for i in range(1, slides + 1)
            ]
        },
        assets=[],
    )


def telemetry_of(response: Any) -> dict[str, Any]:
    return dict(getattr(response, "layoutTelemetry", None) or {})


def entries_of(response: Any) -> list[dict[str, Any]]:
    return list(telemetry_of(response).get("entries") or [])


def pages_of(response: Any) -> set[int]:
    return {int(e.get("page") or 0) for e in entries_of(response)}


def main() -> int:
    # --- К1. Ответ эндпоинта несёт телеметрию --------------------------------
    single = app.orion_render_golden(deck(1, "К1"))
    entries = entries_of(single)
    check(
        "К1а: модель ответа несёт непустую layoutTelemetry.entries",
        len(entries) > 0,
        f"записей {len(entries)}",
    )
    check(
        "К1б: версия телеметрии названа",
        telemetry_of(single).get("version") == "orion-layout-telemetry-v1",
        f"версия {telemetry_of(single).get('version')!r}",
    )
    required = ("page", "role", "requiredHeight", "availableHeight")
    missing = [k for k in required for e in entries if k not in e]
    check(
        "К1в: записи несут page, role, requiredHeight, availableHeight",
        len(entries) > 0 and not missing,
        f"нет полей: {sorted(set(missing))}",
    )

    # --- К2. Параллельные рендеры не перемешивают телеметрию ------------------
    # Опорные значения снимаются последовательно: сколько записей и какие
    # страницы даёт каждая дека сама по себе.
    small, large = deck(2, "малая"), deck(6, "большая")
    solo_small = app.orion_render_golden(small)
    solo_large = app.orion_render_golden(large)
    want_small = (len(entries_of(solo_small)), pages_of(solo_small))
    want_large = (len(entries_of(solo_large)), pages_of(solo_large))
    check(
        "К2а: опорные рендеры различимы по числу записей",
        want_small[0] > 0 and want_large[0] > want_small[0],
        f"малая {want_small[0]}, большая {want_large[0]}",
    )

    barrier = threading.Barrier(2)

    def render_together(req: app.OrionGoldenRenderRequest) -> Any:
        barrier.wait(timeout=60)
        return app.orion_render_golden(req)

    with ThreadPoolExecutor(max_workers=2) as pool:
        fut_small = pool.submit(render_together, small)
        fut_large = pool.submit(render_together, large)
        got_small, got_large = fut_small.result(), fut_large.result()

    check(
        "К2б: малая дека получила ровно свою телеметрию",
        (len(entries_of(got_small)), pages_of(got_small)) == want_small,
        f"записей {len(entries_of(got_small))} (ждали {want_small[0]}), "
        f"страницы {sorted(pages_of(got_small))}",
    )
    check(
        "К2в: большая дека получила ровно свою телеметрию",
        (len(entries_of(got_large)), pages_of(got_large)) == want_large,
        f"записей {len(entries_of(got_large))} (ждали {want_large[0]}), "
        f"страницы {sorted(pages_of(got_large))}",
    )

    # --- К3. Лок не остаётся захваченным после отказа рендера ----------------
    # Лок глобальный: если упавший рендер его не отпустит, следующий кейс
    # встанет навсегда, а не подождёт. Отказ вызывается подменой самой функции
    # рендера — так проверяется дисциплина эндпоинта, а не то, какие деки
    # рендерер согласен принять.
    original = app.render_orion_golden

    def boom(_payload: Any) -> Any:
        raise RuntimeError("рендер упал внутри лока")

    app.render_orion_golden = boom  # type: ignore[assignment]
    raised = ""
    try:
        app.orion_render_golden(deck(1, "К3"))
    except Exception as exc:  # noqa: BLE001
        raised = type(exc).__name__
    finally:
        app.render_orion_golden = original  # type: ignore[assignment]

    check(
        "К3а: отказ рендера доходит до вызывающего",
        raised == "HTTPException",
        f"исключение: {raised or 'нет'}",
    )
    check(
        "К3б: лок отпущен после отказа рендера",
        not app._GOLDEN_RENDER_LOCK.locked(),
    )
    check(
        "К3в: рендер после отказа по-прежнему проходит",
        len(entries_of(app.orion_render_golden(deck(1, "К3")))) > 0,
    )

    print(f"\n{'FAILED (' + str(len(failures)) + ')' if failures else 'PASSED (0 failures)'}")
    # Мера отдаёт потери сайдбара — иначе дека узнаёт о них только у ворот
    # выпуска, когда отчёт уже не выдан (прогон DPA-2026-0053, стр. 62).
    import base64  # noqa: PLC0415
    import io  # noqa: PLC0415

    from PIL import Image  # noqa: PLC0415

    buf = io.BytesIO()
    Image.new("RGB", (1200, 420), (0xF2, 0xF5, 0xF3)).save(buf, format="PNG")
    unbreakable = "слово" * 320  # одно «предложение» длиннее любой колонки: ни целого предложения не влезет
    panel = app.OrionGoldenRenderRequest(
        reportSpec={"subject": {"displayName": "Субъект меры"}},
        deckManifest={
            "finalSlides": [
                {
                    "slideKey": "p10_ru_serp_visual",
                    "template": "orion_golden_surface_panel",
                    "templateId": "serp-screenshot-analysis",
                    "title": "Россия — снимок выдачи",
                    "assetRefs": ["ru_serp_snapshot"],
                    "visualAnalysis": {
                        "sidebarMode": "context",
                        "headlineConclusion": "Вывод панели.",
                        "whatIsVisible": unbreakable,
                        "recommendedActions": ["Сверить."],
                    },
                    "pageNumber": 1,
                    "totalPageCount": 1,
                }
            ]
        },
        assets=[
            {
                "assetRef": "ru_serp_snapshot",
                "kind": "serp_screenshot",
                "title": "Снимок",
                "imageData": base64.b64encode(buf.getvalue()).decode("ascii"),
            }
        ],
    )
    measured = app.orion_measure_layout(panel)
    losses = list(getattr(measured, "sidebars", None) or [])
    check(
        "мера называет потерю блока сайдбара: страницу и поле",
        any(int(l.get("page") or 0) == 1 and l.get("field") == "whatIsVisible" and int(l.get("droppedLines") or 0) > 0 for l in losses),
        f"sidebars={losses!r}"[:200],
    )
    clean = app.orion_measure_layout(deck(1, "К-мера"))
    check(
        "у страницы без потерь список потерь сайдбара пуст",
        list(getattr(clean, "sidebars", None) or []) == [],
        f"sidebars={getattr(clean, 'sidebars', None)!r}"[:200],
    )
    print_tap_counters(passed=passed_checks, failed=len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
