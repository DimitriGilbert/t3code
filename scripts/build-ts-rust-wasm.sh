#!/usr/bin/env bash
# Regenerates apps/server/vendor/ts-rust-wasm/ts_rust.wasm from upstream
# ts-rust (https://github.com/pingdotgg/ts-rust). The ts-rust-wasm npm
# package is not published, so the wasm module is self-built — see
# apps/server/vendor/ts-rust-wasm/VENDORED.md for the layout.
#
# usage: scripts/build-ts-rust-wasm.sh
# needs: git, rustup, cargo, node
set -euo pipefail

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="$repo/apps/server/vendor/ts-rust-wasm"

# The upstream commit the vendored files were taken from. Bump this (and
# the same hash in VENDORED.md) to update the vendored module; refresh
# core.js/core.d.ts from npm/wasm/ at the same commit.
pin="780dc512d64f40afebffa6a7028207649fb7ed1c"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git clone --quiet https://github.com/pingdotgg/ts-rust.git "$tmp/ts-rust"
git -C "$tmp/ts-rust" checkout --quiet "$pin"

rustup target add wasm32-wasip1

# WASM_OPT=none skips wasm-opt so binaryen is not required. The module is a
# committed artifact; size is traded for a cargo-only regen.
WASM_OPT=none "$tmp/ts-rust/scripts/wasm/build.sh" "$out_dir/ts_rust.wasm"

# The host shim ships alongside the module — keep it byte-identical to the
# pinned commit so the bridge protocol (crates/ts_wasm host.rs) matches.
cp "$tmp/ts-rust/npm/wasm/core.js" "$tmp/ts-rust/npm/wasm/core.d.ts" "$out_dir/"

echo "vendored ts-rust wasm refreshed at $pin -> $out_dir"
