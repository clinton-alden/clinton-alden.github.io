#!/usr/bin/env python3
"""Expose locally cached live JSON as the script payloads used by Fire Tools."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIVE = ROOT / "assets" / "live"
PAYLOADS = {
    "firms.json": "__FIRE_FIRMS__",
    "incidents.json": "__FIRE_INCIDENTS__",
    "airnow-pm25.json": "__FIRE_AIRNOW__",
    "evacuations.json": "__FIRE_EVACUATIONS__",
    "pct-closures.json": "__PCT_CLOSURES__",
    "fuel-moisture.json": "__FIRE_FUEL_MOISTURE__",
    "hrrr-smoke/manifest.json": "__HRRR_SMOKE_MANIFEST__",
    "hrrr-smoke/pct-smoke.json": "__HRRR_PCT_SMOKE__",
}

for relative_path, global_name in PAYLOADS.items():
    source = LIVE / relative_path
    if not source.exists():
        continue
    payload = json.dumps(json.loads(source.read_text()), separators=(",", ":"))
    source.with_suffix(".data.js").write_text(f"window.{global_name}={payload};")
