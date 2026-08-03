#!/usr/bin/env python3
"""Build compact, static HRRR smoke overlays for the Fire Tools page."""

from __future__ import annotations

import json
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests
from eccodes import codes_get, codes_get_array, codes_grib_new_from_file, codes_release
from PIL import Image
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "assets" / "live" / "hrrr-smoke"
NOMADS = "https://nomads.ncep.noaa.gov/cgi-bin/filter_hrrr_2d.pl"
WEST = {"west": -127.0, "east": -102.0, "south": 30.0, "north": 51.0}
RESOLUTION = 0.05
HOURS = range(49)
FIELDS = {
    "surface": {
        "parameter": "MASSDEN",
        "label": "Near-surface smoke",
        "units": "ug m-3",
        "breaks": [1, 5, 15, 35, 75, 150],
    },
    "column": {
        "parameter": "COLMD",
        "label": "Vertically integrated smoke",
        "units": "mg m-2",
        "breaks": [0.25, 1, 3, 6, 12, 25],
    },
}
COLORS = np.array([
    [254, 240, 138, 80],
    [253, 186, 116, 110],
    [251, 146, 60, 145],
    [239, 68, 68, 175],
    [190, 24, 93, 205],
    [107, 33, 168, 225],
], dtype=np.uint8)


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    for name in FIELDS:
        (OUTPUT / name).mkdir(parents=True)

    try:
        run = find_latest_completed_run()
    except Exception as error:
        write_unavailable_manifest(error)
        return
    regrid = Regridder()
    for hour in HOURS:
        fields = download_hour(run, hour)
        for name, config in FIELDS.items():
            values, latitudes, longitudes = fields[config["parameter"]]
            regular = regrid.to_regular(values, latitudes, longitudes)
            render_overlay(regular, config["breaks"], OUTPUT / name / f"f{hour:03d}.webp")

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "model": "NOAA HRRR Smoke",
        "run": run.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bounds": [[WEST["south"], WEST["west"]], [WEST["north"], WEST["east"]]],
        "resolutionDegrees": RESOLUTION,
        "hours": list(HOURS),
        "fields": {
            name: {
                "label": config["label"],
                "units": config["units"],
                "breaks": config["breaks"],
                "path": f"{name}/f{{hour}}.webp",
            }
            for name, config in FIELDS.items()
        },
    }
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))


def write_unavailable_manifest(error: Exception) -> None:
    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "available": False,
        "message": "The latest HRRR Smoke run is not available from NOAA yet. The next scheduled refresh will retry.",
    }
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"HRRR Smoke unavailable: {error}")


def find_latest_completed_run() -> datetime:
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    candidate = now.replace(hour=(now.hour // 6) * 6)
    for _ in range(5):
        try:
            download_hour(candidate, 48)
            return candidate
        except Exception:
            candidate -= timedelta(hours=6)
    raise RuntimeError("No completed 48-hour HRRR Smoke run was available.")


def download_hour(run: datetime, hour: int) -> dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]]:
    run_date = run.strftime("%Y%m%d")
    cycle = run.strftime("%H")
    filename = f"hrrr.t{cycle}z.wrfsfcf{hour:02d}.grib2"
    params = {
        "dir": f"/hrrr.{run_date}/conus",
        "file": filename,
        "var_MASSDEN": "on",
        "var_COLMD": "on",
        "subregion": "",
        "leftlon": WEST["west"],
        "rightlon": WEST["east"],
        "toplat": WEST["north"],
        "bottomlat": WEST["south"],
    }
    response = requests.get(NOMADS, params=params, timeout=120)
    response.raise_for_status()
    if response.content[:4] != b"GRIB":
        raise requests.RequestException(f"HRRR subset unavailable for {run_date} {cycle}Z f{hour:02d}.")

    temporary = OUTPUT / f".hrrr-{cycle}-{hour:02d}.grib2"
    temporary.write_bytes(response.content)
    try:
        return read_fields(temporary)
    finally:
        temporary.unlink(missing_ok=True)


def read_fields(path: Path) -> dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]]:
    found: dict[str, list[tuple[int, np.ndarray, np.ndarray, np.ndarray]]] = {}
    with path.open("rb") as handle:
        while message := codes_grib_new_from_file(handle):
            try:
                parameter = str(codes_get(message, "shortName")).upper()
                if parameter not in {config["parameter"] for config in FIELDS.values()}:
                    continue
                level_type = str(codes_get(message, "typeOfLevel"))
                level = int(codes_get(message, "level")) if level_type not in {"surface", "entireAtmosphere"} else 0
                values = np.asarray(codes_get_array(message, "values"), dtype=np.float32)
                missing = float(codes_get(message, "missingValue"))
                values[np.isclose(values, missing)] = np.nan
                latitudes = np.asarray(codes_get_array(message, "latitudes"), dtype=np.float32)
                longitudes = np.asarray(codes_get_array(message, "longitudes"), dtype=np.float32)
                longitudes = np.where(longitudes > 180, longitudes - 360, longitudes)
                preference = level if parameter == "MASSDEN" else 0
                found.setdefault(parameter, []).append((preference, values, latitudes, longitudes))
            finally:
                codes_release(message)

    selected = {parameter: min(messages, key=lambda item: item[0])[1:] for parameter, messages in found.items()}
    required = {config["parameter"] for config in FIELDS.values()}
    missing = required - selected.keys()
    if missing:
        raise RuntimeError(f"HRRR response did not contain: {', '.join(sorted(missing))}.")
    return selected


class Regridder:
    def __init__(self) -> None:
        self.target_lats = np.arange(WEST["south"], WEST["north"] + RESOLUTION / 2, RESOLUTION, dtype=np.float32)
        self.target_lons = np.arange(WEST["west"], WEST["east"] + RESOLUTION / 2, RESOLUTION, dtype=np.float32)
        lon_grid, lat_grid = np.meshgrid(self.target_lons, self.target_lats)
        self.target_points = np.column_stack((lat_grid.ravel(), lon_grid.ravel()))
        self.indices: np.ndarray | None = None

    def to_regular(self, values: np.ndarray, latitudes: np.ndarray, longitudes: np.ndarray) -> np.ndarray:
        if self.indices is None:
            tree = cKDTree(np.column_stack((latitudes, longitudes)))
            self.indices = tree.query(self.target_points, workers=-1)[1]
        return values[self.indices].reshape(len(self.target_lats), len(self.target_lons))


def render_overlay(values: np.ndarray, breaks: list[float], output: Path) -> None:
    image_values = values[::-1]
    rgba = np.zeros((*image_values.shape, 4), dtype=np.uint8)
    finite = np.isfinite(image_values)
    categories = np.digitize(np.nan_to_num(image_values, nan=0), breaks, right=False) - 1
    visible = finite & (image_values >= breaks[0])
    rgba[visible] = COLORS[np.clip(categories[visible], 0, len(COLORS) - 1)]
    Image.fromarray(rgba, mode="RGBA").save(output, "WEBP", lossless=True, method=6)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"HRRR smoke processing failed: {error}", file=sys.stderr)
        raise
