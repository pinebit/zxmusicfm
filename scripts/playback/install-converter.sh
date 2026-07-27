#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
revision="$(node --input-type=module --eval \
  "import { ENGINE_COMMIT } from '$project_root/src/playback/enginePin.ts'; process.stdout.write(ENGINE_COMMIT);")"

cd "$project_root"
rustup run 1.95.0 cargo install \
  --locked \
  --git https://github.com/pinebit/ym2149-rs \
  --rev "$revision" \
  --root .tools \
  ym2149-psg2ym6
