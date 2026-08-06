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
WEST = {"west": -125.0, "east": -102.0, "south": 31.0, "north": 50.0}
RESOLUTION = 0.05
WIND_RESOLUTION = 0.03
HOURS = range(49)
MAX_RUN_AGE_HOURS = 24
WIND_MAX_SPEED = 60.0
PCT_MARKERS_URL = "https://services5.arcgis.com/ZldHa25efPFpMmfB/arcgis/rest/services/PCT_Mile_Markers_2026/FeatureServer/0/query"
FIELDS = {
    "surface": {
        "parameter": "MASSDEN",
        "grib_parameter": (0, 20, 0),
        "unit_scale": 1_000_000_000,
        "label": "Near-surface smoke",
        "units": "ug m-3",
        "breaks": [0, 9, 35, 55, 125, 250],
        "display_min": 1,
        "colors": ["#22c55e", "#facc15", "#f97316", "#ef4444", "#a855f7", "#7e22ce"],
        "rgba": np.array([
            [34, 197, 94, 80], [250, 204, 21, 105], [249, 115, 22, 140],
            [239, 68, 68, 170], [168, 85, 247, 200], [126, 34, 206, 225],
        ], dtype=np.uint8),
    },
    "column": {
        "parameter": "COLMD",
        "grib_parameter": (0, 20, 1),
        "unit_scale": 1_000_000,
        "label": "Vertically integrated smoke",
        "units": "mg m-2",
        "breaks": [1, 4, 7, 11, 15, 20, 25, 30, 40, 50, 75, 150, 250, 500],
        "display_min": 1,
        "colors": ["#c7dbed", "#91bdd7", "#4d96c2", "#1f67a7", "#158345", "#56b35d", "#a5d66a", "#fff5ad", "#ffb15c", "#f7844c", "#ef5938", "#c62129", "#ac0032", "#9b00e8"],
        "rgba": np.array([
            [199, 219, 237, 95], [145, 189, 215, 110], [77, 150, 194, 125], [31, 103, 167, 140],
            [21, 131, 69, 145], [86, 179, 93, 150], [165, 214, 106, 155], [255, 245, 173, 160],
            [255, 177, 92, 165], [247, 132, 76, 175], [239, 89, 56, 185], [198, 33, 41, 195],
            [172, 0, 50, 210], [155, 0, 232, 225],
        ], dtype=np.uint8),
    },
}
WIND_PARAMETERS = {
    "UGRD": (0, 2, 2),
    "VGRD": (0, 2, 3),
}


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    for name in FIELDS:
        (OUTPUT / name).mkdir(parents=True)
    (OUTPUT / "winds").mkdir(parents=True)

    run = find_latest_completed_run()
    regrid = Regridder()
    wind_regrid = Regridder(WIND_RESOLUTION)
    try:
        pct_miles = fetch_pct_miles()
    except Exception as error:
        print(f"PCT mileage markers were unavailable: {error}", file=sys.stderr)
        pct_miles = []
    for hour in HOURS:
        fields = download_hour(run, hour)
        for name, config in FIELDS.items():
            values, latitudes, longitudes = fields[config["parameter"]]
            regular = regrid.to_regular(values * config["unit_scale"], latitudes, longitudes)
            render_overlay(regular, config["breaks"], config["display_min"], config["rgba"], OUTPUT / name / f"f{hour:03d}.webp")
            if name == "surface":
                sample_pct_smoke(pct_miles, regular, regrid)
        u_values, latitudes, longitudes = fields["UGRD"]
        v_values, _, _ = fields["VGRD"]
        u_regular = wind_regrid.to_regular(u_values, latitudes, longitudes)
        v_regular = wind_regrid.to_regular(v_values, latitudes, longitudes)
        render_wind_grid(u_regular, v_regular, OUTPUT / "winds" / f"f{hour:03d}.webp")

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "model": "NOAA HRRR Smoke",
        "run": run.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bounds": [[WEST["south"], WEST["west"]], [WEST["north"], WEST["east"]]],
        "resolutionDegrees": RESOLUTION,
        "hours": list(HOURS),
        "wind": {
            "path": "winds/f{hour}.webp",
            "resolutionDegrees": WIND_RESOLUTION,
            "velocityRange": WIND_MAX_SPEED,
        },
        "fields": {
            name: {
                "label": config["label"],
                "units": config["units"],
                "breaks": config["breaks"],
                "colors": config["colors"],
                "path": f"{name}/f{{hour}}.webp",
            }
            for name, config in FIELDS.items()
        },
    }
    pct_smoke = {
        "run": manifest["run"],
        "units": FIELDS["surface"]["units"],
        "breaks": FIELDS["surface"]["breaks"],
        "colors": FIELDS["surface"]["colors"],
        "source": "Pacific Crest Trail Association mileage markers, CC BY 4.0",
        "miles": pct_miles,
    }
    write_data("manifest", manifest, "__HRRR_SMOKE_MANIFEST__")
    write_data("pct-smoke", pct_smoke, "__HRRR_PCT_SMOKE__")


def write_data(name: str, value: object, global_name: str) -> None:
    payload = json.dumps(value, separators=(",", ":"))
    (OUTPUT / f"{name}.json").write_text(payload)
    (OUTPUT / f"{name}.data.js").write_text(f"window.{global_name}={payload};")


def fetch_pct_miles() -> list[dict[str, float | int | list[float]]]:
    markers = []
    offset = 0
    while True:
        response = requests.get(PCT_MARKERS_URL, params={
            "where": "1=1",
            "outFields": "Mile,lat,lon",
            "returnGeometry": "true",
            "f": "json",
            "resultOffset": offset,
            "resultRecordCount": 2_000,
            "orderByFields": "Mile ASC",
        }, timeout=60)
        response.raise_for_status()
        payload = response.json()
        if payload.get("error"):
            raise RuntimeError(payload["error"].get("message", "PCTA mile-marker query failed."))
        features = payload.get("features", [])
        if not features:
            break
        for feature in features:
            properties = feature.get("attributes", {})
            mile = float(properties.get("Mile", -1))
            geometry = feature.get("geometry", {})
            longitude = geometry.get("x")
            latitude = geometry.get("y")
            if longitude is None or latitude is None or abs(mile - round(mile)) > 0.01:
                continue
            markers.append({"mile": int(round(mile)), "lat": round(latitude, 5), "lon": round(longitude, 5), "values": []})
        if len(features) < 2_000:
            break
        offset += len(features)
    unique = {marker["mile"]: marker for marker in markers}
    return [unique[mile] for mile in sorted(unique)]


def sample_pct_smoke(miles: list[dict[str, float | int | list[float]]], values: np.ndarray, regrid: "Regridder") -> None:
    for marker in miles:
        latitude = float(marker["lat"])
        longitude = float(marker["lon"])
        lat_index = int(np.clip(round((latitude - WEST["south"]) / RESOLUTION), 0, len(regrid.target_lats) - 1))
        lon_index = int(np.clip(round((longitude - WEST["west"]) / RESOLUTION), 0, len(regrid.target_lons) - 1))
        concentration = float(values[lat_index, lon_index])
        marker["values"].append(round(concentration, 1) if np.isfinite(concentration) else None)


def find_latest_completed_run() -> datetime:
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    latest_cycle = now.replace(hour=(now.hour // 6) * 6)
    last_error: Exception | None = None
    for age_hours in range(0, MAX_RUN_AGE_HOURS, 6):
        candidate = latest_cycle.replace() - timedelta(hours=age_hours)
        try:
            download_hour(candidate, 48)
            if age_hours:
                print(f"Latest HRRR Smoke cycle was incomplete; using completed {candidate:%Y-%m-%d %HZ} run.")
            return candidate
        except Exception as error:
            last_error = error
    raise RuntimeError(f"No completed HRRR Smoke run from the last {MAX_RUN_AGE_HOURS} hours was available: {last_error}")


def download_hour(run: datetime, hour: int) -> dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]]:
    run_date = run.strftime("%Y%m%d")
    cycle = run.strftime("%H")
    filename = f"hrrr.t{cycle}z.wrfsfcf{hour:02d}.grib2"
    params = {
        "dir": f"/hrrr.{run_date}/conus",
        "file": filename,
        "var_MASSDEN": "on",
        "var_COLMD": "on",
        "var_UGRD": "on",
        "var_VGRD": "on",
        "lev_8_m_above_ground": "on",
        "lev_10_m_above_ground": "on",
        "lev_entire_atmosphere_(considered_as_a_single_layer)": "on",
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
                grib_parameter = (
                    int(codes_get(message, "discipline")),
                    int(codes_get(message, "parameterCategory")),
                    int(codes_get(message, "parameterNumber")),
                )
                parameter = next(
                    (config["parameter"] for config in FIELDS.values() if config["grib_parameter"] == grib_parameter),
                    None,
                )
                if parameter is None:
                    parameter = next((name for name, code in WIND_PARAMETERS.items() if code == grib_parameter), None)
                if parameter is None:
                    continue
                level_type = str(codes_get(message, "typeOfLevel"))
                level = int(codes_get(message, "level")) if level_type not in {"surface", "entireAtmosphere"} else 0
                values = np.asarray(codes_get_array(message, "values"), dtype=np.float32)
                missing = float(codes_get(message, "missingValue"))
                values[np.isclose(values, missing)] = np.nan
                latitudes = np.asarray(codes_get_array(message, "latitudes"), dtype=np.float32)
                longitudes = np.asarray(codes_get_array(message, "longitudes"), dtype=np.float32)
                longitudes = np.where(longitudes > 180, longitudes - 360, longitudes)
                preference = abs(level - 10) if parameter in WIND_PARAMETERS else level if parameter == "MASSDEN" else 0
                found.setdefault(parameter, []).append((preference, values, latitudes, longitudes))
            finally:
                codes_release(message)

    selected = {parameter: min(messages, key=lambda item: item[0])[1:] for parameter, messages in found.items()}
    required = {config["parameter"] for config in FIELDS.values()} | set(WIND_PARAMETERS)
    missing = required - selected.keys()
    if missing:
        raise RuntimeError(f"HRRR response did not contain: {', '.join(sorted(missing))}.")
    return selected


class Regridder:
    def __init__(self, resolution: float = RESOLUTION) -> None:
        self.target_lats = np.arange(WEST["south"], WEST["north"] + resolution / 2, resolution, dtype=np.float32)
        self.target_lons = np.arange(WEST["west"], WEST["east"] + resolution / 2, resolution, dtype=np.float32)
        lon_grid, lat_grid = np.meshgrid(self.target_lons, self.target_lats)
        self.target_points = np.column_stack((lat_grid.ravel(), lon_grid.ravel()))
        self.indices: np.ndarray | None = None

    def to_regular(self, values: np.ndarray, latitudes: np.ndarray, longitudes: np.ndarray) -> np.ndarray:
        if self.indices is None:
            tree = cKDTree(np.column_stack((latitudes, longitudes)))
            self.indices = tree.query(self.target_points, workers=-1)[1]
        return values[self.indices].reshape(len(self.target_lats), len(self.target_lons))


def render_overlay(values: np.ndarray, breaks: list[float], display_min: float, colors: np.ndarray, output: Path) -> None:
    image_values = values[::-1]
    rgba = np.zeros((*image_values.shape, 4), dtype=np.uint8)
    finite = np.isfinite(image_values)
    categories = np.digitize(np.nan_to_num(image_values, nan=0), breaks, right=False) - 1
    visible = finite & (image_values >= display_min)
    rgba[visible] = colors[np.clip(categories[visible], 0, len(colors) - 1)]
    Image.fromarray(rgba, mode="RGBA").save(output, "WEBP", lossless=True, method=6)


def render_wind_grid(u_values: np.ndarray, v_values: np.ndarray, output: Path) -> None:
    """Store u/v in an image so the browser can fetch one 3 km forecast hour at a time."""
    u_values = u_values[::-1]
    v_values = v_values[::-1]
    valid = np.isfinite(u_values) & np.isfinite(v_values)
    encoded_u = np.clip(np.rint((np.nan_to_num(u_values) + WIND_MAX_SPEED) * 255 / (2 * WIND_MAX_SPEED)), 0, 255).astype(np.uint8)
    encoded_v = np.clip(np.rint((np.nan_to_num(v_values) + WIND_MAX_SPEED) * 255 / (2 * WIND_MAX_SPEED)), 0, 255).astype(np.uint8)
    rgb = np.dstack((encoded_u, encoded_v, np.where(valid, 255, 0).astype(np.uint8)))
    Image.fromarray(rgb, mode="RGB").save(output, "WEBP", lossless=True, method=6)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"HRRR smoke processing failed: {error}", file=sys.stderr)
        raise
