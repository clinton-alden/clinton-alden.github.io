#!/usr/bin/env python3
"""Cache official PCTA closure and alert locations for the Fire Dashboard."""

import json
import os
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "assets" / "live"
OVERVIEW_URL = "https://closures.pcta.org/overviewmap"
WRAPPER = 'self.__next_f.push([1,'
PROFILE = Path("/tmp") / f"pcta-closures-{os.getpid()}"


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    try:
        cached_rows = {row.get("id"): row for row in (read_payload() or {}).get("rows", [])}
        locations = extract_map_data(load_page(OVERVIEW_URL, 15000))
        rows = [
            {
                "id": location["id"],
                "name": location["name"],
                "latitude": float(location["lat"]),
                "longitude": float(location["lng"]),
                "url": f"https://closures.pcta.org/closure/{location['id']}",
            }
            for location in locations
            if location.get("id") and location.get("name") and valid_coordinates(location)
        ]
        if not rows:
            raise RuntimeError("PCTA overview map locations were invalid")
        for row in rows:
            cached = cached_rows.get(row["id"], {})
            if cached.get("geometry") and not geometry_refresh_due(cached):
                row["geometry"] = cached["geometry"]
                row["geometryCheckedAt"] = cached.get("geometryCheckedAt")
                continue
            try:
                geometry = extract_closure_geometry(load_page(f"{row['url']}/map/0", 3500))
                if geometry["lines"]["features"] or geometry["polygons"]["features"]:
                    row["geometry"] = geometry
                row["geometryCheckedAt"] = timestamp()
            except Exception as error:
                if cached.get("geometry"):
                    row["geometry"] = cached["geometry"]
                    row["geometryCheckedAt"] = cached.get("geometryCheckedAt")
                print(f"PCTA map geometry unavailable for {row['name']}: {error}")
        write_payload({"generatedAt": timestamp(), "stale": False, "rows": rows})
        print(f"Refreshed {len(rows)} PCTA closure and alert locations.")
    except Exception as error:
        cached = read_payload()
        if cached and cached.get("rows"):
            cached["stale"] = True
            cached["lastAttemptAt"] = timestamp()
            write_payload(cached)
            print(f"PCTA closure refresh failed; retaining {len(cached['rows'])} cached locations: {error}")
        else:
            raise RuntimeError(f"PCTA closure refresh failed with no cached locations: {error}")


def load_page(url, virtual_time):
    browser = next((candidate for candidate in browser_candidates() if candidate), None)
    if not browser:
        raise RuntimeError("No supported Chrome executable was found")
    PROFILE.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            browser, "--headless=new", "--disable-gpu", "--disable-background-networking", "--disable-component-update",
            "--no-first-run", "--no-default-browser-check", f"--user-data-dir={PROFILE}",
            f"--virtual-time-budget={virtual_time}", "--dump-dom", url,
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=90 if virtual_time >= 8000 else 30,
    )
    if not result.stdout.strip():
        raise RuntimeError("PCTA page returned no content")
    return result.stdout


def browser_candidates():
    yield shutil.which("google-chrome")
    yield shutil.which("google-chrome-stable")
    yield shutil.which("chromium")
    yield shutil.which("chromium-browser")
    mac_chrome = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    yield str(mac_chrome) if mac_chrome.exists() else None


def extract_map_data(html):
    marker = html.find("mapData")
    if marker == -1:
        raise RuntimeError("PCTA mapData stream was missing")
    start = html.rfind(WRAPPER, 0, marker)
    end = html.find('\\n"])', marker)
    if start == -1 or end == -1:
        raise RuntimeError("PCTA mapData stream was incomplete")
    stream = react_stream(html, start, end)
    map_marker = stream.find('"mapData":')
    array_start = stream.find("[", map_marker)
    if map_marker == -1 or array_start == -1:
        raise RuntimeError("PCTA mapData array was missing")
    return json.loads(extract_balanced_array(stream, array_start))


def extract_closure_geometry(html):
    marker = html.find('\\"points\\"')
    if marker == -1:
        raise RuntimeError("PCTA closure map data was missing")
    start = html.rfind(WRAPPER, 0, marker)
    end = html.find('\\n"])', marker)
    if start == -1 or end == -1:
        raise RuntimeError("PCTA closure map stream was incomplete")
    stream = react_stream(html, start, end)
    points_marker = stream.find('"points":')
    object_start = stream.rfind('{"location":', 0, points_marker)
    if points_marker == -1 or object_start == -1:
        raise RuntimeError("PCTA closure map geometry was missing")
    map_data = json.loads(extract_balanced_object(stream, object_start))
    return {
        "lines": map_data.get("lines", {"type": "FeatureCollection", "features": []}),
        "polygons": map_data.get("polygons", {"type": "FeatureCollection", "features": []}),
    }


def react_stream(html, start, end):
    return json.loads(html[start + len(WRAPPER):end + 3])


def extract_balanced_array(source, start):
    return extract_balanced_value(source, start, "[", "]")


def extract_balanced_object(source, start):
    return extract_balanced_value(source, start, "{", "}")


def extract_balanced_value(source, start, opening, closing):
    depth = 0
    quoted = False
    escaped = False
    for index, character in enumerate(source[start:], start):
        if quoted:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quoted = False
            continue
        if character == '"':
            quoted = True
        elif character == opening:
            depth += 1
        elif character == closing:
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise RuntimeError("PCTA mapData array was incomplete")


def geometry_refresh_due(row):
    checked_at = row.get("geometryCheckedAt")
    if not checked_at:
        return True
    try:
        checked = datetime.fromisoformat(checked_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    return datetime.now(timezone.utc) - checked >= timedelta(hours=6)


def valid_coordinates(location):
    try:
        latitude = float(location["lat"])
        longitude = float(location["lng"])
    except (KeyError, TypeError, ValueError):
        return False
    return -90 <= latitude <= 90 and -180 <= longitude <= 180


def read_payload():
    try:
        return json.loads((OUTPUT / "pct-closures.json").read_text())
    except (OSError, json.JSONDecodeError):
        return None


def write_payload(payload):
    (OUTPUT / "pct-closures.json").write_text(json.dumps(payload, separators=(",", ":")))
    (OUTPUT / "pct-closures.data.js").write_text(f"window.__PCT_CLOSURES__={json.dumps(payload, separators=(',', ':'))};")


def timestamp():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    main()
