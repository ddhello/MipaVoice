#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="x86_64-unknown-linux-gnu.2.17"
OUT_DIR="$ROOT_DIR/dist/server-linux-glibc217"

cd "$ROOT_DIR"

command -v cargo >/dev/null 2>&1 || {
  echo "cargo is not installed. Install Rust first." >&2
  exit 1
}

command -v cargo-zigbuild >/dev/null 2>&1 || {
  echo "cargo-zigbuild is not installed. Run: cargo install cargo-zigbuild" >&2
  exit 1
}

command -v zig >/dev/null 2>&1 || {
  echo "zig is not installed. Install Zig in WSL first." >&2
  exit 1
}

mkdir -p "$OUT_DIR"

cargo zigbuild --release -p mipavoice-server --target "$TARGET"

cp "$ROOT_DIR/target/$TARGET/release/mipavoice-server" "$OUT_DIR/mipavoice-server"
chmod +x "$OUT_DIR/mipavoice-server"

echo "Built: $OUT_DIR/mipavoice-server"
file "$OUT_DIR/mipavoice-server" || true

