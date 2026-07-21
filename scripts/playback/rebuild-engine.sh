#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
temporary_root="$(mktemp -d)"
engine_checkout="$temporary_root/ym2149-rs"
bindgen_output="$temporary_root/pkg"
revision="b3096aac0dcab6dd1d82c0209f579761943aadc6"

cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT

git clone --filter=blob:none https://github.com/slippyex/ym2149-rs.git "$engine_checkout"
git -C "$engine_checkout" checkout --detach "$revision"
cp "$project_root/vendor/ym2149/Cargo.lock" "$engine_checkout/Cargo.lock"

rustup run 1.88.0 cargo build \
  --manifest-path "$engine_checkout/Cargo.toml" \
  --release \
  --locked \
  --package ym2149-wasm \
  --target wasm32-unknown-unknown

wasm-bindgen \
  "$engine_checkout/target/wasm32-unknown-unknown/release/ym2149_wasm.wasm" \
  --target web \
  --out-dir "$bindgen_output" \
  --out-name ym2149_wasm \
  --typescript

cp "$bindgen_output"/ym2149_wasm.js \
  "$bindgen_output"/ym2149_wasm.d.ts \
  "$bindgen_output"/ym2149_wasm_bg.wasm \
  "$bindgen_output"/ym2149_wasm_bg.wasm.d.ts \
  "$project_root/vendor/ym2149/"

cd "$project_root"
npm run engine:verify
