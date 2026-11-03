#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m venv apps/api/.venv
apps/api/.venv/bin/python -m pip install --upgrade pip
apps/api/.venv/bin/python -m pip install -r apps/api/requirements-translation.txt
echo "Local translation dependencies installed. The 2.3 GB model downloads on first translation."
