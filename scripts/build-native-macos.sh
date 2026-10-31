#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/macos/DeskreenVirtualDisplay.m"
OUT_DIR="$ROOT/out/native"
OUT="$OUT_DIR/DeskreenVirtualDisplay"

# Keep the resources directory present on every platform so electron-builder
# can always copy it.
mkdir -p "$OUT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
	echo "Skipping macOS virtual display helper (not running on macOS)"
	exit 0
fi

if [[ ! -f "$SRC" ]]; then
	echo "Native helper source not found: $SRC" >&2
	exit 1
fi

clang \
	-fobjc-arc \
	-O2 \
	-mmacosx-version-min=11.0 \
	-framework Foundation \
	-framework CoreFoundation \
	-framework CoreGraphics \
	-o "$OUT" \
	"$SRC"

# Ad-hoc signing keeps macOS from quarantining a freshly built local binary.
codesign --force --sign - "$OUT" >/dev/null 2>&1 || true

echo "Built $OUT"
