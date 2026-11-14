#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"
TRANSFER_PYTHON="$PROJECT_DIR/.local/transfer-venv/bin/python"
if [ ! -x "$TRANSFER_PYTHON" ]; then
  python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else "Direct transfers need Python 3.11 or newer.")'
  python3 -m venv "$PROJECT_DIR/.local/transfer-venv"
fi
if ! "$TRANSFER_PYTHON" -c 'import aiortc; assert aiortc.__version__ == "1.16.0"' 2>/dev/null; then
  "$TRANSFER_PYTHON" -m pip install --only-binary=:all: -r requirements-transfer.txt
fi
exec "$TRANSFER_PYTHON" companion.py serve "$@"
