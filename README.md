# ZX-MUSIC.FM

A small, polished web player for a curated collection of ZX Spectrum AY/YM chip
music. It performs deterministic content preparation, verified in-browser YM6
playback, real three-channel waveforms and meters, sequencing, persistence,
accessible controls, recoverable errors, and credits. Project conventions and
constraints live in [AGENTS.md](AGENTS.md).

## Toolchain

- Node.js 24.14.1
- npm 11.12.1

Install exactly from the lockfile:

```sh
npm ci
```

## Commands

```sh
npm run dev
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:e2e
npm run engine:verify
npm run content:generate
npm run content:validate
npm run build
```

`npm run engine:rebuild` is the exceptional maintainer command for rebuilding
the pinned browser engine artifacts. It requires Rust 1.88.0, the
`wasm32-unknown-unknown` target, and `wasm-bindgen-cli` 0.2.105. Ordinary
installation, testing, AY/YM/PSG preparation, and production builds remain
Node-only.

The content commands accept a local `--file` or direct HTTPS `--url`. Remote
retrieval validates every redirect and destination, limits downloads to 16 MiB,
and keeps the retrieval URL separate from the required human-facing
`--source-url`. Non-interactive imports provide metadata explicitly, for example:

```sh
npm run content:import -- \
  --file ./track.psg --non-interactive \
  --id track-id --order 2 --title "Track" --author "Author" \
  --source-url https://example.com/source \
  --chip-type AY --chip-clock-hz 1773400 --frame-rate-hz 50 \
  --channel-layout ABC
```

AY, YM, and PSG content preparation is Node-only. PT3, STC, and ASC tracker
imports additionally require a running Docker Desktop on macOS. The importer
builds a Linux `zxtune123` image from pinned commit
`8e8228ee8c1fa0bb5e63e5c8254603aa86bcef2a`, verifies ZXTune's detected module
type, converts to a provenance-bound intermediate PSG in a network-disabled
container, and then uses the same PSG-to-YM6 and waveform gates. No Android
application or Android build is used.

`content:update` never changes a permanent ID and requires `--replace-source`
before replacing authoritative bytes. `content:remove` prints its exact target;
non-interactive removal requires both `--non-interactive` and `--yes`. Import,
update, and removal stage generation and validation before atomically replacing
the repository content directories.

Catalog size is a curatorial choice rather than a validation constraint; every
present track must still pass the complete content, provenance, ordering,
waveform, and playback checks.

## Repository policy

Implementation work must remain unstaged and uncommitted. Do not configure
remotes or push from the implementation workflow.
