#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8000}"

if [[ "${1:-}" == "--refresh-smoke" ]]; then
  VENV="$ROOT/.venv"
  if [[ ! -x "$VENV/bin/python" ]]; then
    python3 -m venv "$VENV"
  fi
  if ! "$VENV/bin/python" -c 'import numpy, requests, scipy, PIL, eccodes' >/dev/null 2>&1; then
    "$VENV/bin/python" -m pip install --disable-pip-version-check numpy pillow requests scipy eccodes
  fi
  "$VENV/bin/python" "$ROOT/scripts/fetch-hrrr-smoke.py"
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--refresh-smoke]" >&2
  exit 2
fi

python3 "$ROOT/scripts/build-preview-data.py"

exec python3 -m http.server "$PORT" --directory "$ROOT"
