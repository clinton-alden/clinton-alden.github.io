#!/usr/bin/env python3
"""Build compact, static NOAA UV Index overlays for the UV Index page."""

from __future__ import annotations

import json
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import requests
from eccodes import codes_get, codes_get_array, codes_grib_new_from_file, codes_release
from PIL import Image
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "assets" / "live" / "uvi"
TEMP = OUTPUT.parent / ".uvi-tmp"
NOMADS_BASE = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/uvi/prod"
RUN_HOUR = 12
MAX_RUN_AGE_DAYS = 3
BOUNDS = {"west": -125.0, "east": -66.0, "south": 24.0, "north": 50.0}
RESOLUTION = 0.10
UVI_SCALE = 40.0
DISPLAY_MIN = 0.25
BREAKS = [0, 2, 3, 5, 6, 7, 8, 10, 11]
COLORS = ["#3bb273", "#8cc63f", "#f4d03f", "#f59e0b", "#ef6c00", "#e53935", "#b91c1c", "#8e24aa", "#6d28d9"]
RGBA = np.array([
    [59, 178, 115, 115],
    [140, 198, 63, 125],
    [244, 208, 63, 140],
    [245, 158, 11, 155],
    [239, 108, 0, 170],
    [229, 57, 53, 185],
    [185, 28, 28, 200],
    [142, 36, 170, 215],
    [109, 40, 217, 225],
], dtype=np.uint8)
TIME_ZONES = [
    ZoneInfo("America/Los_Angeles"),
    ZoneInfo("America/Denver"),
    ZoneInfo("America/Chicago"),
    ZoneInfo("America/New_York"),
]


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    cached_manifest = OUTPUT / "manifest.json"
    cached = json.loads(cached_manifest.read_text()) if cached_manifest.exists() else None
    try:
        build_latest()
    except Exception as error:
        if TEMP.exists():
            shutil.rmtree(TEMP)
        if cached:
            print(f"NOAA UV refresh failed; retaining cached run from {cached.get('run', 'unknown')}: {error}", file=sys.stderr)
            cached["stale"] = True
            cached["lastAttemptAt"] = now_iso()
            cached["message"] = str(error)
            write_data("manifest", cached, "__NOAA_UVI_MANIFEST__")
            return
        print(f"NOAA UV refresh failed with no cached run: {error}", file=sys.stderr)
        OUTPUT.mkdir(parents=True, exist_ok=True)
        write_data("manifest", {
            "generatedAt": now_iso(),
            "model": "NOAA CPC UV Index Forecast",
            "available": False,
            "stale": True,
            "message": str(error),
            "frames": [],
        }, "__NOAA_UVI_MANIFEST__")


def build_latest() -> None:
    if TEMP.exists():
        shutil.rmtree(TEMP)
    TEMP.mkdir(parents=True)

    run, files = find_latest_run()
    regridder = WebMercatorOverlayRegridder()
    frames = []
    for hour, path in files:
        values, latitudes, longitudes = read_uv_field(path)
        path.unlink(missing_ok=True)
        uvi = values * UVI_SCALE
        overlay = regridder.to_regular(uvi, latitudes, longitudes)
        render_overlay(overlay, TEMP / f"f{hour:03d}.webp")
        valid = run + timedelta(hours=hour)
        frames.append({
            "hour": hour,
            "validTime": valid.isoformat().replace("+00:00", "Z"),
            "path": f"f{hour:03d}.webp",
            "maxUvi": round(float(np.nanmax(uvi)), 1),
        })

    if not frames:
        raise RuntimeError("No current-day NOAA UV forecast hours were available.")

    manifest = {
        "generatedAt": now_iso(),
        "model": "NOAA CPC UV Index Forecast",
        "run": run.isoformat().replace("+00:00", "Z"),
        "source": "https://www.cpc.ncep.noaa.gov/products/stratosphere/uv_index/uv_global.shtml",
        "bounds": [[BOUNDS["south"], BOUNDS["west"]], [BOUNDS["north"], BOUNDS["east"]]],
        "resolutionDegrees": RESOLUTION,
        "rasterProjection": "EPSG:3857",
        "units": "UV Index",
        "breaks": BREAKS,
        "colors": COLORS,
        "displayMin": DISPLAY_MIN,
        "frames": frames,
        "stale": False,
    }

    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    TEMP.rename(OUTPUT)
    write_data("manifest", manifest, "__NOAA_UVI_MANIFEST__")


def find_latest_run() -> tuple[datetime, list[tuple[int, Path]]]:
    now = datetime.now(timezone.utc)
    candidates = [
        datetime(now.year, now.month, now.day, RUN_HOUR, tzinfo=timezone.utc) - timedelta(days=age)
        for age in range(MAX_RUN_AGE_DAYS + 1)
    ]
    last_error: Exception | None = None
    for run in candidates:
        try:
            files = download_current_day_files(run, now)
            if files:
                return run, files
        except Exception as error:
            last_error = error
    raise RuntimeError(f"No NOAA UV Index run from the last {MAX_RUN_AGE_DAYS} days was available: {last_error}")


def download_current_day_files(run: datetime, now: datetime) -> list[tuple[int, Path]]:
    hours = current_day_forecast_hours(run, now)
    if not hours:
        hours = range(1, 37)
    files = []
    for hour in hours:
        path = download_hour(run, hour)
        files.append((hour, path))
    return files


def current_day_forecast_hours(run: datetime, now: datetime) -> range:
    selected: set[int] = set()
    for zone in TIME_ZONES:
        local_today = now.astimezone(zone).date()
        for hour in range(1, 49):
            if (run + timedelta(hours=hour)).astimezone(zone).date() == local_today:
                selected.add(hour)
    if not selected:
        return range(0)
    return range(min(selected), max(selected) + 1)


def download_hour(run: datetime, hour: int) -> Path:
    run_date = run.strftime("%Y%m%d")
    url = f"{NOMADS_BASE}/uvi.{run_date}/uv.t12z.grbf{hour:02d}.grib2"
    response = requests.get(url, timeout=60)
    response.raise_for_status()
    if response.content[:4] != b"GRIB":
        raise RuntimeError(f"NOAA UV Index file was not GRIB2: {url}")
    path = TEMP / f".uv-{hour:03d}.grib2"
    path.write_bytes(response.content)
    return path


def read_uv_field(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    with path.open("rb") as handle:
        message = codes_grib_new_from_file(handle)
        if not message:
            raise RuntimeError(f"No GRIB message found in {path.name}")
        try:
            values = np.asarray(codes_get_array(message, "values"), dtype=np.float32)
            missing = float(codes_get(message, "missingValue"))
            values[np.isclose(values, missing)] = np.nan
            latitudes = np.asarray(codes_get_array(message, "latitudes"), dtype=np.float32)
            longitudes = np.asarray(codes_get_array(message, "longitudes"), dtype=np.float32)
            longitudes = np.where(longitudes > 180, longitudes - 360, longitudes)
            return values, latitudes, longitudes
        finally:
            codes_release(message)


class WebMercatorOverlayRegridder:
    def __init__(self, resolution: float = RESOLUTION) -> None:
        width = round((BOUNDS["east"] - BOUNDS["west"]) / resolution)
        height = round((BOUNDS["north"] - BOUNDS["south"]) / resolution)
        self.target_lons = BOUNDS["west"] + (np.arange(width, dtype=np.float32) + 0.5) * (BOUNDS["east"] - BOUNDS["west"]) / width
        north_y = web_mercator_y(BOUNDS["north"])
        south_y = web_mercator_y(BOUNDS["south"])
        target_y = north_y + (np.arange(height, dtype=np.float32) + 0.5) * (south_y - north_y) / height
        self.target_lats = web_mercator_latitude(target_y)
        lon_grid, lat_grid = np.meshgrid(self.target_lons, self.target_lats)
        self.target_points = np.column_stack((lat_grid.ravel(), lon_grid.ravel()))
        self.indices: np.ndarray | None = None

    def to_regular(self, values: np.ndarray, latitudes: np.ndarray, longitudes: np.ndarray) -> np.ndarray:
        if self.indices is None:
            tree = cKDTree(np.column_stack((latitudes, longitudes)))
            self.indices = tree.query(self.target_points, workers=-1)[1]
        return values[self.indices].reshape(len(self.target_lats), len(self.target_lons))


def web_mercator_y(latitude: float | np.ndarray) -> float | np.ndarray:
    return np.log(np.tan(np.pi / 4 + np.deg2rad(latitude) / 2))


def web_mercator_latitude(y: np.ndarray) -> np.ndarray:
    return np.rad2deg(2 * np.arctan(np.exp(y)) - np.pi / 2)


def render_overlay(values: np.ndarray, output: Path) -> None:
    rgba = np.zeros((*values.shape, 4), dtype=np.uint8)
    finite = np.isfinite(values)
    categories = np.digitize(np.nan_to_num(values, nan=0), BREAKS, right=False) - 1
    visible = finite & (values >= DISPLAY_MIN)
    rgba[visible] = RGBA[np.clip(categories[visible], 0, len(RGBA) - 1)]
    Image.fromarray(rgba, mode="RGBA").save(output, "WEBP", lossless=True, method=6)


def write_data(name: str, value: object, global_name: str) -> None:
    payload = json.dumps(value, separators=(",", ":"))
    (OUTPUT / f"{name}.json").write_text(payload)
    (OUTPUT / f"{name}.data.js").write_text(f"window.{global_name}={payload};")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    main()
