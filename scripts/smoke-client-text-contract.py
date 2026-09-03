#!/usr/bin/env python3
"""REMEDIATION §6.1 — Python side of client-text-contract parity smoke.

Usage:
  python scripts/smoke-client-text-contract.py --json '[{"text":"...","surface":"body"}]'
Prints JSON array of evaluate_client_text verdicts to stdout.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "renderer"))

from client_text_contract import evaluate_client_text, load_bundled_contract  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", required=True, help="JSON list of {text, surface, quoted?}")
    args = parser.parse_args()
    fixtures = json.loads(args.json)
    # Ensure bundled contract loads (fail fast if JSON missing/invalid).
    load_bundled_contract()
    out = [
        evaluate_client_text(
            str(f.get("text") or ""),
            surface=str(f.get("surface") or "body"),
            quoted=bool(f.get("quoted")),
        )
        for f in fixtures
    ]
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
